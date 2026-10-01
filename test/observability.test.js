import test, { after } from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";

const ORCHESTRATOR_TOKEN = "observability-orchestrator-token";
const server = createServer({
  orchestratorToken: ORCHESTRATOR_TOKEN,
  workerToken: "observability-worker-token",
  bootstrapToken: "observability-bootstrap-token",
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("metrics endpoint is authenticated and normalizes dynamic route identifiers", async () => {
  const denied = await fetch(base + "/metrics");
  assert.equal(denied.status, 401);

  await fetch(base + "/livez");
  await fetch(
    base + "/v1/platform/public/reports/opaque-share-token-123",
  );

  const response = await fetch(base + "/metrics", {
    headers: { Authorization: `Bearer ${ORCHESTRATOR_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/plain/);
  const body = await response.text();
  assert.match(body, /mecord_http_requests_total/);
  assert.match(body, /mecord_http_request_duration_seconds_bucket/);
  assert.match(body, /\/v1\/platform\/public\/reports\/:token/);
  assert.equal(body.includes("opaque-share-token-123"), false);
});
