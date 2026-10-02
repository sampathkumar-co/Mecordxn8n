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
  assert.equal(calls[2].options.headers.authorization, "Bearer secret");
  assert.equal(result.content[0].text, "accepted");
});

test("MCP client prefers OAuth, form-encodes credentials and reuses the token", async () => {
  const calls = [];
  const mcpReplies = [
    response({
      sessionId: "session-oauth",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    }),
    response(),
    response({
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        result: { ok: true },
      }),
    }),
  ];

  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === "https://auth.example.test/token") {
      return response({
        body: JSON.stringify({
          access_token: "oauth-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
      });
    }
    return mcpReplies.shift();
  };

  const client = new MecordMcpClient({
    endpoint: "https://mcp.example.test/mcp",
    token: "legacy-static-token-should-not-win-when-oauth-is-configured",
    oauth: {
      tokenUrl: "https://auth.example.test/token",
      clientId: "service+client",
      clientSecret: "service%secret with reserved characters and enough length",
      audience: "https://mcp.example.test/mcp",
      scope: "operator:read operator:write",
    },
    fetchImpl,
  });

  await client.callTool("operations", { action: "submit" });

  assert.equal(calls.filter((call) => call.url.includes("/token")).length, 1);
  const tokenCall = calls[0];
  const basic = tokenCall.options.headers.authorization.replace(/^Basic /, "");
  assert.equal(
    Buffer.from(basic, "base64").toString("utf8"),
    "service%2Bclient:service%25secret+with+reserved+characters+and+enough+length",
  );
  assert.match(tokenCall.options.body, /grant_type=client_credentials/);
  assert.match(tokenCall.options.body, /operator%3Aread\+operator%3Awrite/);
  for (const call of calls.slice(1)) {
    assert.equal(call.options.headers.authorization, "Bearer oauth-access-token");
  }
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
