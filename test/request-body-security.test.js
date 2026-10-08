import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";

test("public JSON mutation routes reject null, arrays and scalar bodies without HTTP 500", async () => {
  const server = createServer({
    orchestratorToken: "test-orchestrator-secret-only",
    workerToken: "test-worker-secret-only",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = "http://127.0.0.1:" + server.address().port + "/v1/platform/auth/login";
    for (const body of ["null", "true", "false", "[]", '"hello"', "7", "{"]) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const payload = await response.json();
      assert.equal(response.status, 400, "Expected HTTP 400 for " + body);
      assert.equal(payload.error, "BAD_REQUEST");
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});

test("console rejects hidden files and Windows path escapes while preserving deep links", async () => {
  const server = createServer({
    orchestratorToken: "test-orchestrator-secret-only",
    workerToken: "test-worker-secret-only",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const root = "http://127.0.0.1:" + server.address().port;
    for (const pathname of [
      "/console/.env",
      "/console/.git/config",
      "/console/core/.secret",
      "/console/%5c.env",
    ]) {
      const response = await fetch(root + pathname);
      assert.equal(response.status, 404, pathname + " must not return the HTML shell");
    }
    for (const pathname of ["/console", "/console/targets", "/console/targets/test-id"]) {
      const response = await fetch(root + pathname);
      assert.equal(response.status, 200, pathname + " must remain navigable");
      assert.match(response.headers.get("content-type") || "", /text\/html/);
    }
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
});
