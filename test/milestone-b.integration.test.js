import test, { after } from "node:test";
import assert from "node:assert/strict";

import { CAPABILITIES } from "../src/authorization.js";
import { computeFindingIntelligence } from "../src/milestone-a/intelligence.js";
import { extractRepairLearning } from "../src/milestone-b/repair-intelligence.js";
import { closePool, pool } from "../src/repository.js";
import { createServer } from "../src/server.js";

const enabled = Boolean(process.env.DATABASE_URL);
const TOKEN = "milestone-b-orchestrator";
const WORKER_TOKEN = "milestone-b-worker";

let server;
let baseUrl;

if (enabled) {
  server = createServer({
    orchestratorToken: TOKEN,
    workerToken: WORKER_TOKEN,
  });
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

async function createVerifiedFinding(host = "milestone-b-client.example.com") {
  const target = await request("/v1/targets", {
    method: "POST",
    body: {
      organizationName: "Milestone B Client",
      baseUrl: `https://${host}`,
      authorization: {
        mode: "CLIENT_AUTHORIZED",
        allowedHosts: [host],
        allowedCapabilities: [
          CAPABILITIES.BROWSER_QA,
          CAPABILITIES.FINDING_VERIFY,
          CAPABILITIES.SOURCE_REMEDIATION,
        ],
        expiresAt: "2099-01-01T00:00:00.000Z",
        evidenceReference: "milestone-b-integration",
      },
    },
  });
  assert.equal(target.status, 201);

  const scan = await request("/v1/jobs", {
    method: "POST",
    body: {
      targetId: target.body.id,
      jobType: "browser-qa",
      capability: CAPABILITIES.BROWSER_QA,
      requestedUrl: `https://${host}/checkout`,
      maxAttempts: 1,
      input: { viewport: "mobile" },
    },
  });
  assert.equal(scan.status, 201);

  await pool.query(
    "UPDATE jobs SET created_at = '2000-01-01T00:00:00Z' WHERE id = $1",
    [scan.body.id],
  );

  const lease = await request("/v1/worker/jobs/lease", {
    method: "POST",
    token: WORKER_TOKEN,
    body: {
      workerId: `fixture-browser-${target.body.id}`,
      capabilities: [CAPABILITIES.BROWSER_QA],
      leaseSeconds: 60,
    },
  });
  assert.equal(lease.status, 200);
  assert.equal(lease.body.id, scan.body.id);

  const finding = await request(`/v1/worker/jobs/${scan.body.id}/findings`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: {
      workerId: `fixture-browser-${target.body.id}`,
      finding: {
        fingerprint: `b-checkout-${target.body.id}`,
        category: "browser-network",
        title: "Checkout API regression",
        severity: "MEDIUM",
        confidence: 0.98,
        affectedUrl: `https://${host}/checkout`,
        evidence: {
          status: 500,
          viewport: "mobile",
          errorText: "checkout request failed",
        },
      },
    },
  });
  assert.equal(finding.status, 201);

  await request(`/v1/worker/jobs/${scan.body.id}/complete`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: {
      workerId: `fixture-browser-${target.body.id}`,
      state: "SUCCEEDED",
      output: {},
    },
  });

  const verifyQueue = await request(`/v1/findings/${finding.body.id}/verify`, {
    method: "POST",
  });
  assert.equal(verifyQueue.status, 201);

  await pool.query(
    "UPDATE jobs SET created_at = '2000-01-02T00:00:00Z' WHERE id = $1",
    [verifyQueue.body.id],
  );

  const verifyWorker = `fixture-verifier-${target.body.id}`;
  const verifyLease = await request("/v1/worker/jobs/lease", {
    method: "POST",
    token: WORKER_TOKEN,
    body: {
      workerId: verifyWorker,
      capabilities: [CAPABILITIES.FINDING_VERIFY],
      leaseSeconds: 60,
    },
  });
  assert.equal(verifyLease.status, 200);
  assert.equal(verifyLease.body.id, verifyQueue.body.id);

  const intelligence = computeFindingIntelligence(
    finding.body,
    { status: "VERIFIED", confidence: 1 },
  );
  const verification = await request(
    `/v1/worker/milestone-a/jobs/${verifyQueue.body.id}/verification`,
    {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: verifyWorker,
        findingId: finding.body.id,
        status: "VERIFIED",
        attempts: 2,
        matchedAttempts: 2,
        confidence: 1,
        evidence: { runs: [{ matched: true }, { matched: true }] },
        artifacts: [],
        intelligence,
      },
    },
  );
  assert.equal(verification.status, 201);

  await request(`/v1/worker/jobs/${verifyQueue.body.id}/complete`, {
    method: "POST",
    token: WORKER_TOKEN,
    body: { workerId: verifyWorker, state: "SUCCEEDED", output: {} },
  });

  return { target: target.body, finding: finding.body };
}

test(
  "Milestone B enforces approval, idempotent execution, report release, and repair learning",
  { skip: !enabled },
  async () => {
    const { target, finding } = await createVerifiedFinding();

    const remediation = await request(
      `/v1/findings/${finding.id}/remediate`,
      {
        method: "POST",
        body: {
          projectRoot: "C:\\authorized\\milestone-b-client",
          requestedBy: "sampath",
        },
      },
    );
    assert.equal(remediation.status, 202);
    assert.equal(remediation.body.approval.status, "PENDING");

    const beforeApproval = await pool.query(
      "SELECT COUNT(*)::int AS count FROM jobs WHERE input->>'approvalId' = $1",
      [remediation.body.approval.id],
    );
    assert.equal(beforeApproval.rows[0].count, 0);

    const approved = await request(
      `/v1/approvals/${remediation.body.approval.id}/approve`,
      {
        method: "POST",
        body: { decidedBy: "sampath", decisionNote: "Authorized client repair." },
      },
    );
    assert.equal(approved.status, 201);
    assert.equal(approved.body.job.capability, CAPABILITIES.SOURCE_REMEDIATION);
    assert.equal(approved.body.job.input.approvalId, remediation.body.approval.id);

    const replay = await request(
      `/v1/approvals/${remediation.body.approval.id}/approve`,
      {
        method: "POST",
        body: { decidedBy: "sampath" },
      },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotentReplay, true);
    assert.equal(replay.body.job.id, approved.body.job.id);

    await pool.query(
      "UPDATE jobs SET created_at = '1999-01-01T00:00:00Z' WHERE id = $1",
      [approved.body.job.id],
    );
    const remediationWorker = "fixture-remediation-b";
    const remediationLease = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: remediationWorker,
        capabilities: [CAPABILITIES.SOURCE_REMEDIATION],
        leaseSeconds: 60,
      },
    });
    assert.equal(remediationLease.status, 200);
    assert.equal(remediationLease.body.id, approved.body.job.id);

    const remediationResult = await request(
      `/v1/worker/milestone-a/jobs/${approved.body.job.id}/remediation-result`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: remediationWorker,
          status: "SUCCEEDED",
          mcpRequestId: "11111111-1111-4111-8111-111111111111",
          mcpResult: { summary: "patched and quality gates passed" },
        },
      },
    );
    assert.equal(remediationResult.status, 200);

    const findingContext = {
      ...finding,
      verification: { status: "VERIFIED" },
    };
    const learning = extractRepairLearning({
      finding: findingContext,
      remediationResult: { summary: "patched and quality gates passed" },
      outcome: "SUCCESS",
    });

    const learned = await request(
      `/v1/worker/milestone-b/jobs/${approved.body.job.id}/repair-outcome`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: remediationWorker,
          remediationRequestId: approved.body.remediationRequest.id,
          findingId: finding.id,
          learning,
        },
      },
    );
    assert.equal(learned.status, 201);

    await request(`/v1/worker/jobs/${approved.body.job.id}/complete`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: remediationWorker,
        state: "SUCCEEDED",
        output: { repaired: true },
      },
    });

    const patterns = await request(
      "/v1/repair-patterns?category=browser-network",
    );
    assert.equal(patterns.status, 200);
    assert.ok(patterns.body.patterns.some(
      (pattern) => pattern.patternKey === learned.body.patternKey,
    ));

    const report = await request(`/v1/targets/${target.id}/reports`, {
      method: "POST",
      body: {},
    });
    assert.equal(report.status, 201);
    assert.equal(report.body.status, "READY");

    const release = await request(
      `/v1/reports/${report.body.id}/request-release`,
      {
        method: "POST",
        body: { requestedBy: "sampath" },
      },
    );
    assert.equal(release.status, 202);

    const releaseApproval = await request(
      `/v1/approvals/${release.body.approval.id}/approve`,
      {
        method: "POST",
        body: { decidedBy: "sampath" },
      },
    );
    assert.equal(releaseApproval.status, 200);
    assert.equal(releaseApproval.body.report.status, "APPROVED");

    const metrics = await request("/v1/ops/metrics");
    assert.equal(metrics.status, 200);
    assert.ok("jobs" in metrics.body);
    assert.ok("monitoring" in metrics.body);
  },
);

test(
  "continuous monitoring creates a baseline, detects a regression, and resolves it",
  { skip: !enabled },
  async () => {
    const host = "monitor-b.example.com";
    const target = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Monitor B",
        baseUrl: `https://${host}`,
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: [host],
        },
      },
    });
    assert.equal(target.status, 201);

    const policy = await request(`/v1/targets/${target.body.id}/monitors`, {
      method: "POST",
      body: {
        name: "Homepage availability",
        capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
        requestedUrl: `https://${host}/`,
        cadenceMinutes: 5,
        dailyBudgetUnits: 10,
      },
    });
    assert.equal(policy.status, 201);

    async function queueAndLease() {
      const tick = await request("/v1/monitoring/tick", {
        method: "POST",
        body: { limit: 100 },
      });
      assert.equal(tick.status, 200);
      const queued = tick.body.queued.find(
        (item) => item.policyId === policy.body.id,
      );
      assert.ok(queued);

      await pool.query(
        "UPDATE jobs SET created_at = '1998-01-01T00:00:00Z' WHERE id = $1",
        [queued.jobId],
      );

      const workerId = `monitor-worker-${queued.jobId}`;
      const lease = await request("/v1/worker/jobs/lease", {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId,
          capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
          leaseSeconds: 60,
        },
      });
      assert.equal(lease.status, 200);
      assert.equal(lease.body.id, queued.jobId);
      return { queued, workerId };
    }

    const first = await queueAndLease();
    const baseline = await request(
      `/v1/worker/milestone-b/jobs/${first.queued.jobId}/monitoring-run`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: first.workerId,
          policyId: policy.body.id,
          costUnits: 0.25,
          snapshot: {
            kind: "http",
            statusCode: 200,
            latencyMs: 100,
            contentType: "text/html",
            location: null,
          },
        },
      },
    );
    assert.equal(baseline.status, 201);
    assert.equal(baseline.body.state, "BASELINE");
    await request(`/v1/worker/jobs/${first.queued.jobId}/complete`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { workerId: first.workerId, state: "SUCCEEDED", output: {} },
    });

    await request(`/v1/monitors/${policy.body.id}/enable`, {
      method: "POST",
      body: {},
    });
    const second = await queueAndLease();
    const regression = await request(
      `/v1/worker/milestone-b/jobs/${second.queued.jobId}/monitoring-run`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: second.workerId,
          policyId: policy.body.id,
          costUnits: 0.25,
          snapshot: {
            kind: "http",
            statusCode: 503,
            latencyMs: 1800,
            contentType: "text/html",
            location: null,
          },
        },
      },
    );
    assert.equal(regression.status, 201);
    assert.equal(regression.body.state, "REGRESSION");
    assert.ok(regression.body.regressions.length >= 1);
    await request(`/v1/worker/jobs/${second.queued.jobId}/complete`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { workerId: second.workerId, state: "SUCCEEDED", output: {} },
    });

    const open = await request(`/v1/targets/${target.body.id}/regressions`);
    assert.equal(open.status, 200);
    assert.ok(open.body.regressions.length >= 1);

    await request(`/v1/monitors/${policy.body.id}/enable`, {
      method: "POST",
      body: {},
    });
    const third = await queueAndLease();
    const recovered = await request(
      `/v1/worker/milestone-b/jobs/${third.queued.jobId}/monitoring-run`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: third.workerId,
          policyId: policy.body.id,
          costUnits: 0.25,
          snapshot: {
            kind: "http",
            statusCode: 200,
            latencyMs: 110,
            contentType: "text/html",
            location: null,
          },
        },
      },
    );
    assert.equal(recovered.status, 201);
    assert.equal(recovered.body.state, "HEALTHY");
    await request(`/v1/worker/jobs/${third.queued.jobId}/complete`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { workerId: third.workerId, state: "SUCCEEDED", output: {} },
    });

    const resolved = await request(
      `/v1/targets/${target.body.id}/regressions`,
    );
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.regressions.length, 0);

    const budgetPolicy = await request(
      `/v1/targets/${target.body.id}/monitors`,
      {
        method: "POST",
        body: {
          name: "Budget bounded",
          capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
          requestedUrl: `https://${host}/budget`,
          cadenceMinutes: 5,
          dailyBudgetUnits: 0.1,
        },
      },
    );
    assert.equal(budgetPolicy.status, 201);

    const budgetTick = await request("/v1/monitoring/tick", {
      method: "POST",
      body: { limit: 100 },
    });
    assert.ok(
      budgetTick.body.skipped.some(
        (item) =>
          item.policyId === budgetPolicy.body.id &&
          item.reason === "DAILY_BUDGET_EXCEEDED",
      ),
    );
  },
);

test(
  "worker heartbeat renews leases and retry exhaustion dead-letters the job",
  { skip: !enabled },
  async () => {
    const host = "retry-b.example.com";
    const target = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Retry B",
        baseUrl: `https://${host}`,
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: [host],
        },
      },
    });

    const queued = await request("/v1/jobs", {
      method: "POST",
      body: {
        targetId: target.body.id,
        jobType: "retry-test",
        capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
        requestedUrl: `https://${host}/`,
        maxAttempts: 2,
        input: {},
      },
    });
    assert.equal(queued.status, 201);
    assert.equal(queued.body.maxAttempts, 2);

    await pool.query(
      "UPDATE jobs SET created_at = '1997-01-01T00:00:00Z' WHERE id = $1",
      [queued.body.id],
    );

    const first = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: "retry-worker-1",
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 30,
      },
    });
    assert.equal(first.status, 200);
    assert.equal(first.body.id, queued.body.id);

    const heartbeat = await request(
      `/v1/worker/jobs/${queued.body.id}/heartbeat`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: "retry-worker-1",
          leaseSeconds: 120,
        },
      },
    );
    assert.equal(heartbeat.status, 200);

    const retry = await request(
      `/v1/worker/jobs/${queued.body.id}/complete`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: "retry-worker-1",
          state: "FAILED",
          error: { code: "TRANSIENT" },
        },
      },
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.body.state, "QUEUED");
    assert.ok(retry.body.nextAttemptAt);

    await pool.query(
      `UPDATE jobs
          SET next_attempt_at = now() - interval '1 second',
              created_at = '1997-01-01T00:00:00Z'
        WHERE id = $1`,
      [queued.body.id],
    );

    const second = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: "retry-worker-2",
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 60,
      },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.id, queued.body.id);
    assert.equal(second.body.attemptCount, 2);

    const dead = await request(
      `/v1/worker/jobs/${queued.body.id}/complete`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: "retry-worker-2",
          state: "FAILED",
          error: { code: "FINAL_FAILURE" },
        },
      },
    );
    assert.equal(dead.status, 200);
    assert.equal(dead.body.state, "DEAD_LETTER");

    const fetched = await request(`/v1/jobs/${queued.body.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.state, "DEAD_LETTER");
  },
);

test(
  "expired approvals and revoked authorizations fail closed",
  { skip: !enabled },
  async () => {
    const host = "fail-closed-b.example.com";
    const target = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Fail Closed B",
        baseUrl: `https://${host}`,
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: [host],
        },
      },
    });
    assert.equal(target.status, 201);

    const report = await request(`/v1/targets/${target.body.id}/reports`, {
      method: "POST",
      body: {},
    });
    assert.equal(report.status, 201);

    const release = await request(
      `/v1/reports/${report.body.id}/request-release`,
      {
        method: "POST",
        body: { requestedBy: "expiry-test" },
      },
    );
    assert.equal(release.status, 202);

    await pool.query(
      "UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE id = $1",
      [release.body.approval.id],
    );

    const expired = await request(
      `/v1/approvals/${release.body.approval.id}/approve`,
      {
        method: "POST",
        body: { decidedBy: "late-human" },
      },
    );
    assert.equal(expired.status, 409);
    assert.equal(expired.body.error, "APPROVAL_EXPIRED");

    const reportAfter = await request(`/v1/reports/${report.body.id}`);
    assert.equal(reportAfter.body.status, "READY");

    const queued = await request("/v1/jobs", {
      method: "POST",
      body: {
        targetId: target.body.id,
        jobType: "revocation-test",
        capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
        requestedUrl: `https://${host}/`,
        maxAttempts: 1,
        input: {},
      },
    });
    assert.equal(queued.status, 201);

    await pool.query(
      "UPDATE authorizations SET revoked_at = now() WHERE target_id = $1 AND revoked_at IS NULL",
      [target.body.id],
    );

    const maintenance = await request("/v1/monitoring/tick", {
      method: "POST",
      body: { limit: 10 },
    });
    assert.equal(maintenance.status, 200);
    assert.ok(maintenance.body.cancelledForAuthorization >= 1);

    const cancelled = await request(`/v1/jobs/${queued.body.id}`);
    assert.equal(cancelled.body.state, "CANCELLED");
    assert.equal(
      cancelled.body.error.code,
      "AUTHORIZATION_NO_LONGER_VALID",
    );
  },
);
