import test from "node:test";
import assert from "node:assert/strict";

import { MecordMcpClient } from "../src/mcp/mecord-client.js";

function response({ body = "", sessionId = null, status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "mcp-session-id" ? sessionId : null;
      },
    },
    async text() {
      return body;
    },
  };
}

test("MCP client initializes a session then calls the remediation tool", async () => {
  const calls = [];
  const replies = [
    response({
      sessionId: "session-1",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    }),
    response(),
    response({
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: "accepted" }] },
      }),
    }),
  ];

  const fetchImpl = async (url, options) => {
    calls.push({ url, options, payload: JSON.parse(options.body) });
    return replies.shift();
  };

  const client = new MecordMcpClient({
    endpoint: "https://mcp.example.test/mcp",
    token: "secret",
    fetchImpl,
  });

  const result = await client.callTool("operations", { action: "submit" });

  assert.equal(calls[0].payload.method, "initialize");
  assert.equal(calls[1].payload.method, "notifications/initialized");
  assert.equal(calls[2].payload.method, "tools/call");
  assert.equal(calls[2].payload.params.name, "operations");
  assert.equal(calls[2].options.headers["mcp-session-id"], "session-1");
  assert.equal(result.content[0].text, "accepted");
});

test("MCP client propagates the remediation abort signal", async () => {
  const controller = new AbortController();
  const signals = [];
  const replies = [
    response({
      sessionId: "session-abort",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    }),
    response(),
    response({
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }),
    }),
  ];
  const client = new MecordMcpClient({
    endpoint: "https://mcp.example.test/mcp",
    fetchImpl: async (_url, options) => {
      signals.push(options.signal);
      return replies.shift();
    },
  });

  await client.callTool(
    "operations",
    { action: "submit" },
    { signal: controller.signal },
  );
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal === controller.signal));
});


test("MCP client refreshes OAuth once after a 401 without leaking credentials", async () => {
  const calls = [];
  let tokenIssue = 0;
  let mcpAttempt = 0;

  const fetchImpl = async (url, options) => {
    const target = String(url);
    calls.push({ target, authorization: options.headers?.authorization });
    if (target === "https://auth.example.test/token") {
      tokenIssue += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "oauth-token-" + tokenIssue,
            token_type: "Bearer",
            expires_in: 900,
          };
        },
      };
    }

    mcpAttempt += 1;
    if (mcpAttempt === 1) {
      return response({ status: 401 });
    }
    if (mcpAttempt === 2) {
      return response({
        sessionId: "oauth-session",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
      });
    }
    if (mcpAttempt === 3) return response();
    return response({
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { ok: true },
      }),
    });
  };

  const client = new MecordMcpClient({
    endpoint: "https://mcp.example.test/mcp",
    oauth: {
      tokenUrl: "https://auth.example.test/token",
      clientId: "machine-client",
      clientSecret: "machine-secret",
      scope: "operator:read operator:write",
      resource: "https://mcp.example.test/mcp",
    },
    fetchImpl,
  });

  const result = await client.callTool("operations", { action: "submit" });
  assert.equal(result.ok, true);
  assert.equal(tokenIssue, 2);
  const mcpCalls = calls.filter((entry) =>
    entry.target === "https://mcp.example.test/mcp"
  );
  assert.equal(mcpCalls[0].authorization, "Bearer oauth-token-1");
  assert.equal(mcpCalls[1].authorization, "Bearer oauth-token-2");
  assert.ok(
    mcpCalls.slice(1).every(
      (entry) => entry.authorization === "Bearer oauth-token-2",
    ),
  );
});
