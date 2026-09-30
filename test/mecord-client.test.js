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
