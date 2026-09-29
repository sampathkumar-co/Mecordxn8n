import test, { after } from "node:test";
import assert from "node:assert/strict";

import { CAPABILITIES } from "../src/authorization.js";
import { computeFindingIntelligence } from "../src/milestone-a/intelligence.js";
import { closePool } from "../src/repository.js";
import { createServer } from "../src/server.js";

const enabled = Boolean(process.env.DATABASE_URL);
const TOKEN = "milestone-a-orchestrator";
const WORKER_TOKEN = "milestone-a-worker";

let server;
let baseUrl;

if (enabled) {
  server = createServer({ orchestratorToken: TOKEN, workerToken: WORKER_TOKEN });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

test("Milestone A reaches verified opportunity, report, and remediation queue", { skip: !enabled }, async () => {
  const targetRes = await request("/v1/targets", {
    method: "POST",
    body: {
      organizationName: "Milestone A Client",
      baseUrl: "https://client.example.com",
      authorization: {
        mode: "CLIENT_AUTHORIZED",
        allowedHosts: ["client.example.com"],
        allowedCapabilities: [
          CAPABILITIES.BROWSER_QA,
          CAPABILITIES.SITE_DISCOVERY,
          CAPABILITIES.JOURNEY_QA,
          CAPABILITIES.FINDING_VERIFY,
          CAPABILITIES.SOURCE_REMEDIATION
        ],
        expiresAt: "2099-01-01T00:00:00.000Z",
        evidenceReference: "test-client-authorization"
      }
    }
  });
  assert.equal(targetRes.status, 201);

  const jobRes = await request("/v1/jobs", {
    method: "POST",
    body: {
      targetId: targetRes.body.id,
      jobType: "browser-qa",
      capability: CAPABILITIES.BROWSER_QA,
      requestedUrl: "https://client.example.com/checkout",
      input: { viewport: "mobile" }
    }
  });
  assert.equal(jobRes.status, 201);

  const lease = await request("/v1/worker/jobs/lease", {
    method: "POST",
    token: WORKER_TOKEN,
    body: {
      workerId: "fixture-browser",
      capabilities: [CAPABILITIES.BROWSER_QA],
      leaseSeconds: 60
    }
  });
  assert.equal(lease.status, 200);

  const findingRes = await request(`/v1/worker/jobs/${lease.body.id}/findings`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: {
      workerId: "fixture-browser",
      finding: {
        fingerprint: "milestone-a-checkout-failure",
        category: "browser-network",
        title: "Checkout API failed",
        severity: "MEDIUM",
        confidence: 0.98,
        affectedUrl: "https://client.example.com/checkout",
        evidence: { status: 500, viewport: "mobile" }
      }
    }
  });
  assert.equal(findingRes.status, 201);

  await request(`/v1/worker/jobs/${lease.body.id}/complete`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: { workerId: "fixture-browser", state: "SUCCEEDED", output: {} }
  });

  const verifyQueue = await request(`/v1/findings/${findingRes.body.id}/verify`, {
    method: "POST"
  });
  assert.equal(verifyQueue.status, 201);

  const verifyLease = await request("/v1/worker/jobs/lease", {
    method: "POST",
    token: WORKER_TOKEN,
    body: {
      workerId: "fixture-verifier",
      capabilities: [CAPABILITIES.FINDING_VERIFY],
      leaseSeconds: 60
    }
  });
  assert.equal(verifyLease.status, 200);

  const intelligence = computeFindingIntelligence(
    findingRes.body,
    { status: "VERIFIED", confidence: 1 },
  );

  const verification = await request(
    `/v1/worker/milestone-a/jobs/${verifyLease.body.id}/verification`,
    {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: "fixture-verifier",
        findingId: findingRes.body.id,
        status: "VERIFIED",
        attempts: 2,
        matchedAttempts: 2,
        confidence: 1,
        evidence: { runs: [{ matched: true }, { matched: true }] },
        artifacts: [],
        intelligence
      }
    }
  );
  assert.equal(verification.status, 201);

  await request(`/v1/worker/jobs/${verifyLease.body.id}/complete`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: { workerId: "fixture-verifier", state: "SUCCEEDED", output: {} }
  });

  const opportunities = await request(
    `/v1/targets/${targetRes.body.id}/opportunities`,
  );
  assert.equal(opportunities.status, 200);
  assert.equal(opportunities.body.findings.length, 1);
  assert.ok(opportunities.body.findings[0].intelligence.opportunityScore > 0);

  const report = await request(`/v1/targets/${targetRes.body.id}/reports`, {
    method: "POST",
    body: {}
  });
  assert.equal(report.status, 201);
  assert.match(report.body.markdown, /Checkout API failed/);
  assert.match(report.body.markdown, /directional/i);

  const remediation = await request(
    `/v1/findings/${findingRes.body.id}/remediate`,
    {
      method: "POST",
      body: { projectRoot: "C:\\authorized\\client" }
    }
  );
  assert.equal(remediation.status, 201);
  assert.equal(remediation.body.job.capability, CAPABILITIES.SOURCE_REMEDIATION);
});

test("new Milestone A routes return 403 when capability is not granted", { skip: !enabled }, async () => {
  const targetRes = await request("/v1/targets", {
    method: "POST",
    body: {
      organizationName: "Restricted Client",
      baseUrl: "https://restricted.example.com",
      authorization: {
        mode: "CLIENT_AUTHORIZED",
        allowedHosts: ["restricted.example.com"],
        allowedCapabilities: [CAPABILITIES.BROWSER_QA],
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    }
  });

  const journey = await request(`/v1/targets/${targetRes.body.id}/journeys`, {
    method: "POST",
    body: {
      steps: [{ path: "/" }]
    }
  });

  assert.equal(journey.status, 403);
  assert.equal(journey.body.error, "CAPABILITY_NOT_GRANTED");
});
