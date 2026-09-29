import test, { after } from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { closePool } from "../src/repository.js";
import { CAPABILITIES } from "../src/authorization.js";

const enabled = Boolean(process.env.DATABASE_URL);
const TOKEN = "integration-test-token";

let server;
let baseUrl;

if (enabled) {
  server = createServer({ orchestratorToken: TOKEN });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
}

after(async () => {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (enabled) await closePool();
});

async function request(path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return {
    status: response.status,
    body: await response.json(),
  };
}

test(
  "public QA target cannot queue active security work",
  { skip: !enabled },
  async () => {
    const targetResponse = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Public QA Test",
        baseUrl: "https://example.com",
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: ["example.com"]
        }
      }
    });

    assert.equal(targetResponse.status, 201);

    const jobResponse = await request("/v1/jobs", {
      method: "POST",
      body: {
        targetId: targetResponse.body.id,
        jobType: "security-active",
        capability: CAPABILITIES.SECURITY_ACTIVE,
        requestedUrl: "https://example.com",
        input: {}
      }
    });

    assert.equal(jobResponse.status, 403);
    assert.equal(jobResponse.body.error, "CAPABILITY_NOT_ALLOWED");
  },
);

test(
  "client authorization can queue an explicitly granted capability",
  { skip: !enabled },
  async () => {
    const targetResponse = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Client Test",
        baseUrl: "https://client.example.com",
        authorization: {
          mode: "CLIENT_AUTHORIZED",
          allowedHosts: ["client.example.com"],
          allowedCapabilities: [CAPABILITIES.SOURCE_REMEDIATION],
          expiresAt: "2099-01-01T00:00:00.000Z",
          evidenceReference: "integration-test"
        }
      }
    });

    assert.equal(targetResponse.status, 201);

    const jobResponse = await request("/v1/jobs", {
      method: "POST",
      body: {
        targetId: targetResponse.body.id,
        jobType: "source-remediation",
        capability: CAPABILITIES.SOURCE_REMEDIATION,
        requestedUrl: "https://client.example.com",
        input: {}
      }
    });

    assert.equal(jobResponse.status, 201);
    assert.equal(jobResponse.body.state, "QUEUED");
  },
);
