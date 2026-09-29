import test, { after } from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server.js";
import { closePool } from "../src/repository.js";
import { CAPABILITIES } from "../src/authorization.js";

const enabled = Boolean(process.env.DATABASE_URL);
const TOKEN = "integration-test-token";
const WORKER_TOKEN = "integration-worker-token";

let server;
let baseUrl;

if (enabled) {
  server = createServer({
    orchestratorToken: TOKEN,
    workerToken: WORKER_TOKEN,
  });
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

async function request(path, { method = "GET", body, token = TOKEN } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const responseBody =
    response.status === 204 ? null : await response.json();

  return {
    status: response.status,
    body: responseBody,
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

test(
  "worker can lease, record a finding, and complete an authorized public observation",
  { skip: !enabled },
  async () => {
    const targetResponse = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Observer Test",
        baseUrl: "https://observer.example.com",
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: ["observer.example.com"]
        }
      }
    });

    assert.equal(targetResponse.status, 201);

    const queued = await request("/v1/jobs", {
      method: "POST",
      body: {
        targetId: targetResponse.body.id,
        jobType: "public-http-observe",
        capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
        requestedUrl: "https://observer.example.com/missing",
        input: {}
      }
    });

    assert.equal(queued.status, 201);

    const leased = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: "integration-observer",
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 60
      }
    });

    assert.equal(leased.status, 200);
    assert.equal(leased.body.id, queued.body.id);
    assert.equal(leased.body.state, "RUNNING");

    const finding = await request(
      `/v1/worker/jobs/${leased.body.id}/findings`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: "integration-observer",
          finding: {
            fingerprint: "integration-fingerprint",
            category: "http-status",
            title: "HTTP 404 on public page",
            severity: "LOW",
            confidence: 0.99,
            affectedUrl: "https://observer.example.com/missing",
            evidence: {
              statusCode: 404
            }
          }
        }
      }
    );

    assert.equal(finding.status, 201);
    assert.equal(finding.body.occurrences, 1);

    const completed = await request(
      `/v1/worker/jobs/${leased.body.id}/complete`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: "integration-observer",
          state: "SUCCEEDED",
          output: {
            statusCode: 404
          }
        }
      }
    );

    assert.equal(completed.status, 200);
    assert.equal(completed.body.state, "SUCCEEDED");

    const fetched = await request(`/v1/jobs/${leased.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.state, "SUCCEEDED");
  },
);
