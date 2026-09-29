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

    learning.successfulStrategy.rawUrl =
      "https://private-client.example/internal?token=secret";
    learning.lessons.sourceCode = "const password = 'do-not-store';";

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
    const serializedPatterns = JSON.stringify(patterns.body.patterns);
    assert.equal(serializedPatterns.includes("private-client.example"), false);
    assert.equal(serializedPatterns.includes("do-not-store"), false);

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
    assert.ok(open.body.regressions.length >= 2);
    const initialFingerprints = new Set(
      open.body.regressions.map((item) => item.fingerprint),
    );

    await request(`/v1/monitors/${policy.body.id}/enable`, {
      method: "POST",
      body: {},
    });
    const third = await queueAndLease();
    const repeated = await request(
      `/v1/worker/milestone-b/jobs/${third.queued.jobId}/monitoring-run`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: third.workerId,
          policyId: policy.body.id,
          costUnits: 99999,
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
    assert.equal(repeated.status, 201);
    assert.equal(repeated.body.state, "REGRESSION");
    await request(`/v1/worker/jobs/${third.queued.jobId}/complete`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { workerId: third.workerId, state: "SUCCEEDED", output: {} },
    });

    const repeatedOpen = await request(
      `/v1/targets/${target.body.id}/regressions`,
    );
    assert.deepEqual(
      new Set(repeatedOpen.body.regressions.map((item) => item.fingerprint)),
      initialFingerprints,
    );
    const repeatedJob = await request(`/v1/jobs/${third.queued.jobId}`);
    assert.equal(repeatedJob.body.costUnits, 0.25);

    await request(`/v1/monitors/${policy.body.id}/enable`, {
      method: "POST",
      body: {},
    });
    const fourth = await queueAndLease();
    const partial = await request(
      `/v1/worker/milestone-b/jobs/${fourth.queued.jobId}/monitoring-run`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: fourth.workerId,
          policyId: policy.body.id,
          snapshot: {
            kind: "http",
            statusCode: 200,
            latencyMs: 1800,
            contentType: "text/html",
            location: null,
          },
        },
      },
    );
    assert.equal(partial.status, 201);
    assert.equal(partial.body.state, "REGRESSION");
    await request(`/v1/worker/jobs/${fourth.queued.jobId}/complete`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { workerId: fourth.workerId, state: "SUCCEEDED", output: {} },
    });

    const partiallyResolved = await request(
      `/v1/targets/${target.body.id}/regressions`,
    );
    assert.equal(partiallyResolved.body.regressions.length, 1);
    assert.equal(partiallyResolved.body.regressions[0].category, "performance");

    await request(`/v1/monitors/${policy.body.id}/enable`, {
      method: "POST",
      body: {},
    });
    const fifth = await queueAndLease();
    const recovered = await request(
      `/v1/worker/milestone-b/jobs/${fifth.queued.jobId}/monitoring-run`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: fifth.workerId,
          policyId: policy.body.id,
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
    await request(`/v1/worker/jobs/${fifth.queued.jobId}/complete`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: { workerId: fifth.workerId, state: "SUCCEEDED", output: {} },
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

test(
  "approval transitions and remediation replay are race-safe",
  { skip: !enabled },
  async () => {
    const { target, finding } = await createVerifiedFinding(
      "approval-race-b.example.com",
    );

    for (const projectRoot of [
      "relative/project",
      "C:\\authorized\\..\\escape",
      "https://example.com/project",
    ]) {
      const malformed = await request(
        `/v1/findings/${finding.id}/remediate`,
        { method: "POST", body: { projectRoot } },
      );
      assert.equal(malformed.status, 400);
    }

    const remediation = await request(
      `/v1/findings/${finding.id}/remediate`,
      {
        method: "POST",
        body: { projectRoot: "C:\\authorized\\approval-race" },
      },
    );
    assert.equal(remediation.status, 202);

    const duplicateRequest = await request(
      `/v1/findings/${finding.id}/remediate`,
      {
        method: "POST",
        body: { projectRoot: "C:\\authorized\\approval-race" },
      },
    );
    assert.equal(duplicateRequest.status, 409);
    assert.equal(duplicateRequest.body.error, "APPROVAL_ALREADY_PENDING");

    const approvals = await Promise.all([
      request(`/v1/approvals/${remediation.body.approval.id}/approve`, {
        method: "POST",
        body: { decidedBy: "human-a" },
      }),
      request(`/v1/approvals/${remediation.body.approval.id}/approve`, {
        method: "POST",
        body: { decidedBy: "human-b" },
      }),
    ]);
    assert.deepEqual(
      approvals.map((item) => item.status).sort(),
      [200, 201],
    );
    assert.equal(approvals[0].body.job.id, approvals[1].body.job.id);

    const jobCount = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM jobs
        WHERE input->>'approvalId' = $1`,
      [remediation.body.approval.id],
    );
    assert.equal(jobCount.rows[0].count, 1);
    const remediationCount = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM remediation_requests r
         JOIN jobs j ON j.id = r.job_id
        WHERE j.input->>'approvalId' = $1`,
      [remediation.body.approval.id],
    );
    assert.equal(remediationCount.rows[0].count, 1);

    const rejectAfterApprove = await request(
      `/v1/approvals/${remediation.body.approval.id}/reject`,
      { method: "POST", body: { decidedBy: "human-c" } },
    );
    assert.equal(rejectAfterApprove.status, 409);

    const report = await request(`/v1/targets/${target.id}/reports`, {
      method: "POST",
      body: {},
    });
    const release = await request(
      `/v1/reports/${report.body.id}/request-release`,
      { method: "POST", body: { requestedBy: "report-owner" } },
    );
    assert.equal(release.status, 202);
    const duplicateRelease = await request(
      `/v1/reports/${report.body.id}/request-release`,
      { method: "POST", body: { requestedBy: "report-owner" } },
    );
    assert.equal(duplicateRelease.status, 409);

    const releaseApproved = await request(
      `/v1/approvals/${release.body.approval.id}/approve`,
      { method: "POST", body: { decidedBy: "report-reviewer" } },
    );
    assert.equal(releaseApproved.status, 200);
    assert.equal(releaseApproved.body.report.status, "APPROVED");
    const releaseReplay = await request(
      `/v1/approvals/${release.body.approval.id}/approve`,
      { method: "POST", body: { decidedBy: "report-reviewer" } },
    );
    assert.equal(releaseReplay.status, 200);
    assert.equal(releaseReplay.body.idempotentReplay, true);

    const alreadyReleased = await request(
      `/v1/reports/${report.body.id}/request-release`,
      { method: "POST", body: { requestedBy: "report-owner" } },
    );
    assert.equal(alreadyReleased.status, 409);
    assert.equal(alreadyReleased.body.error, "REPORT_NOT_RELEASABLE");
  },
);

test(
  "monitor claims are single-flight and failed runs consume budget once",
  { skip: !enabled },
  async () => {
    const host = "monitor-race-b.example.com";
    const target = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Monitor Race B",
        baseUrl: `https://${host}`,
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: [host],
        },
      },
    });
    assert.equal(target.status, 201);

    const outOfScope = await request(
      `/v1/targets/${target.body.id}/monitors`,
      {
        method: "POST",
        body: {
          name: "Out of scope",
          capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
          requestedUrl: "https://outside-scope.example.com/",
          cadenceMinutes: 5,
          dailyBudgetUnits: 1,
        },
      },
    );
    assert.equal(outOfScope.status, 403);

    const policy = await request(
      `/v1/targets/${target.body.id}/monitors`,
      {
        method: "POST",
        body: {
          name: "Single flight",
          capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
          requestedUrl: `https://${host}/`,
          cadenceMinutes: 5,
          dailyBudgetUnits: 0.25,
        },
      },
    );
    assert.equal(policy.status, 201);

    const ticks = await Promise.all([
      request("/v1/monitoring/tick", {
        method: "POST",
        body: { limit: 100 },
      }),
      request("/v1/monitoring/tick", {
        method: "POST",
        body: { limit: 100 },
      }),
    ]);
    const queued = ticks.flatMap((item) => item.body.queued)
      .filter((item) => item.policyId === policy.body.id);
    assert.equal(queued.length, 1);

    await pool.query(
      "UPDATE monitoring_policies SET next_run_at = now() - interval '1 second' WHERE id = $1",
      [policy.body.id],
    );
    const whileActive = await request("/v1/monitoring/tick", {
      method: "POST",
      body: { limit: 100 },
    });
    assert.equal(
      whileActive.body.queued.some((item) => item.policyId === policy.body.id),
      false,
    );

    await pool.query(
      `UPDATE jobs
          SET max_attempts = 1, created_at = '1996-01-01T00:00:00Z'
        WHERE id = $1`,
      [queued[0].jobId],
    );
    const workerId = "failed-monitor-worker";
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
    assert.equal(lease.body.id, queued[0].jobId);

    const failed = await request(
      `/v1/worker/milestone-b/jobs/${queued[0].jobId}/monitoring-failure`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId,
          policyId: policy.body.id,
          error: {
            code: "TIMEOUT",
            message: "https://private.example/?token=DO_NOT_STORE",
          },
        },
      },
    );
    assert.equal(failed.status, 201);
    assert.equal(failed.body.state, "FAILED");
    assert.equal(failed.body.duplicate, false);

    const duplicateFailure = await request(
      `/v1/worker/milestone-b/jobs/${queued[0].jobId}/monitoring-failure`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId,
          policyId: policy.body.id,
          error: { code: "TIMEOUT", message: "another private value" },
        },
      },
    );
    assert.equal(duplicateFailure.status, 201);
    assert.equal(duplicateFailure.body.duplicate, true);

    const dead = await request(
      `/v1/worker/jobs/${queued[0].jobId}/complete`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId,
          state: "FAILED",
          error: { code: "TIMEOUT" },
        },
      },
    );
    assert.equal(dead.status, 200);
    assert.equal(dead.body.state, "DEAD_LETTER");

    const runRows = await pool.query(
      "SELECT state, cost_units, snapshot FROM monitoring_runs WHERE job_id = $1",
      [queued[0].jobId],
    );
    assert.equal(runRows.rowCount, 1);
    assert.equal(runRows.rows[0].state, "FAILED");
    assert.equal(Number(runRows.rows[0].cost_units), 0.25);
    assert.deepEqual(runRows.rows[0].snapshot, {
      kind: "failure",
      code: "TIMEOUT",
    });

    const eventRows = await pool.query(
      "SELECT payload FROM operational_events WHERE job_id = $1",
      [queued[0].jobId],
    );
    assert.equal(
      JSON.stringify(eventRows.rows).includes("DO_NOT_STORE"),
      false,
    );

    await pool.query(
      "UPDATE monitoring_policies SET next_run_at = now() - interval '1 second' WHERE id = $1",
      [policy.body.id],
    );
    const exhausted = await request("/v1/monitoring/tick", {
      method: "POST",
      body: { limit: 100 },
    });
    assert.ok(exhausted.body.skipped.some(
      (item) =>
        item.policyId === policy.body.id &&
        item.reason === "DAILY_BUDGET_EXCEEDED",
    ));

    await request(`/v1/monitors/${policy.body.id}/disable`, {
      method: "POST",
      body: {},
    });
    await pool.query(
      "UPDATE monitoring_policies SET next_run_at = now() - interval '1 second' WHERE id = $1",
      [policy.body.id],
    );
    const disabled = await request("/v1/monitoring/tick", {
      method: "POST",
      body: { limit: 100 },
    });
    assert.equal(
      disabled.body.queued.some((item) => item.policyId === policy.body.id),
      false,
    );
  },
);

test(
  "queue leases fail closed across crashes, delayed retries, and revocation",
  { skip: !enabled },
  async () => {
    const host = "queue-hardening-b.example.com";
    const target = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Queue Hardening B",
        baseUrl: `https://${host}`,
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: [host],
        },
      },
    });
    assert.equal(target.status, 201);

    const crashed = await request("/v1/jobs", {
      method: "POST",
      body: {
        targetId: target.body.id,
        jobType: "crash-recovery",
        capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
        requestedUrl: `https://${host}/crash`,
        maxAttempts: 2,
        input: {},
      },
    });
    assert.equal(crashed.status, 201);
    await pool.query(
      "UPDATE jobs SET created_at = '1995-01-01T00:00:00Z' WHERE id = $1",
      [crashed.body.id],
    );

    const firstLease = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: "crash-worker-1",
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 30,
      },
    });
    assert.equal(firstLease.status, 200);
    assert.equal(firstLease.body.id, crashed.body.id);

    const wrongHeartbeat = await request(
      `/v1/worker/jobs/${crashed.body.id}/heartbeat`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: { workerId: "wrong-worker", leaseSeconds: 60 },
      },
    );
    assert.equal(wrongHeartbeat.status, 409);

    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [crashed.body.id],
    );
    const recoveredLease = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: "crash-worker-2",
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 60,
      },
    });
    assert.equal(recoveredLease.status, 200);
    assert.equal(recoveredLease.body.id, crashed.body.id);
    assert.equal(recoveredLease.body.attemptCount, 2);

    const staleHeartbeat = await request(
      `/v1/worker/jobs/${crashed.body.id}/heartbeat`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: { workerId: "crash-worker-1", leaseSeconds: 60 },
      },
    );
    assert.equal(staleHeartbeat.status, 409);

    const dead = await request(
      `/v1/worker/jobs/${crashed.body.id}/complete`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: "crash-worker-2",
          state: "FAILED",
          error: { code: "WORKER_CRASHED_TWICE" },
        },
      },
    );
    assert.equal(dead.status, 200);
    assert.equal(dead.body.state, "DEAD_LETTER");

    const duplicateCompletion = await request(
      `/v1/worker/jobs/${crashed.body.id}/complete`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: "crash-worker-2",
          state: "FAILED",
          error: { code: "DUPLICATE" },
        },
      },
    );
    assert.equal(duplicateCompletion.status, 409);

    const delayed = await request("/v1/jobs", {
      method: "POST",
      body: {
        targetId: target.body.id,
        jobType: "delayed-retry",
        capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
        requestedUrl: `https://${host}/retry`,
        maxAttempts: 2,
        input: {},
      },
    });
    await pool.query(
      "UPDATE jobs SET created_at = '1995-01-02T00:00:00Z' WHERE id = $1",
      [delayed.body.id],
    );
    const delayedFirst = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: "delay-worker-1",
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 60,
      },
    });
    assert.equal(delayedFirst.body.id, delayed.body.id);

    const retryScheduled = await request(
      `/v1/worker/jobs/${delayed.body.id}/complete`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: "delay-worker-1",
          state: "FAILED",
          error: { code: "TRANSIENT" },
        },
      },
    );
    assert.equal(retryScheduled.body.state, "QUEUED");
    assert.ok(retryScheduled.body.nextAttemptAt);

    const tooEarly = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: "delay-worker-early",
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 60,
      },
    });
    assert.equal(tooEarly.status, 204);

    await pool.query(
      "UPDATE jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1",
      [delayed.body.id],
    );
    const delayedSecond = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: "delay-worker-2",
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 60,
      },
    });
    assert.equal(delayedSecond.status, 200);
    assert.equal(delayedSecond.body.id, delayed.body.id);

    await pool.query(
      "UPDATE authorizations SET revoked_at = now() WHERE target_id = $1 AND revoked_at IS NULL",
      [target.body.id],
    );
    const revokedHeartbeat = await request(
      `/v1/worker/jobs/${delayed.body.id}/heartbeat`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: { workerId: "delay-worker-2", leaseSeconds: 60 },
      },
    );
    assert.equal(revokedHeartbeat.status, 409);

    const maintenance = await request("/v1/monitoring/tick", {
      method: "POST",
      body: { limit: 10 },
    });
    assert.ok(maintenance.body.cancelledForAuthorization >= 1);
    const cancelled = await request(`/v1/jobs/${delayed.body.id}`);
    assert.equal(cancelled.body.state, "CANCELLED");
    assert.equal(cancelled.body.leaseOwner, null);

    const completionAfterCancel = await request(
      `/v1/worker/jobs/${delayed.body.id}/complete`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: "delay-worker-2",
          state: "SUCCEEDED",
          output: {},
        },
      },
    );
    assert.equal(completionAfterCancel.status, 409);
  },
);

test(
  "revocation between remediation request and approval prevents execution",
  { skip: !enabled },
  async () => {
    const { target, finding } = await createVerifiedFinding(
      "approval-revoked-b.example.com",
    );
    const remediation = await request(
      `/v1/findings/${finding.id}/remediate`,
      {
        method: "POST",
        body: { projectRoot: "C:\\authorized\\revoked-before-approval" },
      },
    );
    assert.equal(remediation.status, 202);

    await pool.query(
      "UPDATE authorizations SET revoked_at = now() WHERE target_id = $1 AND revoked_at IS NULL",
      [target.id],
    );
    const approval = await request(
      `/v1/approvals/${remediation.body.approval.id}/approve`,
      {
        method: "POST",
        body: { decidedBy: "authorized-human" },
      },
    );
    assert.equal(approval.status, 403);

    const queued = await pool.query(
      "SELECT COUNT(*)::int AS count FROM jobs WHERE input->>'approvalId' = $1",
      [remediation.body.approval.id],
    );
    assert.equal(queued.rows[0].count, 0);
  },
);

test(
  "rejected report approval cannot later be approved",
  { skip: !enabled },
  async () => {
    const host = "report-reject-b.example.com";
    const target = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Report Reject B",
        baseUrl: `https://${host}`,
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: [host],
        },
      },
    });
    const report = await request(`/v1/targets/${target.body.id}/reports`, {
      method: "POST",
      body: {},
    });
    const release = await request(
      `/v1/reports/${report.body.id}/request-release`,
      { method: "POST", body: { requestedBy: "owner" } },
    );
    const rejected = await request(
      `/v1/approvals/${release.body.approval.id}/reject`,
      { method: "POST", body: { decidedBy: "reviewer" } },
    );
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.approval.status, "REJECTED");

    const approveAfterReject = await request(
      `/v1/approvals/${release.body.approval.id}/approve`,
      { method: "POST", body: { decidedBy: "other-reviewer" } },
    );
    assert.equal(approveAfterReject.status, 409);
    const reportAfter = await request(`/v1/reports/${report.body.id}`);
    assert.equal(reportAfter.body.status, "READY");
  },
);

test(
  "dead-lettered monitor crashes are reconciled and do not poison baseline creation",
  { skip: !enabled },
  async () => {
    const host = "monitor-crash-b.example.com";
    const target = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Monitor Crash B",
        baseUrl: `https://${host}`,
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: [host],
        },
      },
    });
    const policy = await request(
      `/v1/targets/${target.body.id}/monitors`,
      {
        method: "POST",
        body: {
          name: "Crash accounting",
          capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
          requestedUrl: `https://${host}/`,
          cadenceMinutes: 5,
          dailyBudgetUnits: 2,
        },
      },
    );
    assert.equal(policy.status, 201);

    const tick = await request("/v1/monitoring/tick", {
      method: "POST",
      body: { limit: 100 },
    });
    const queued = tick.body.queued.find(
      (item) => item.policyId === policy.body.id,
    );
    assert.ok(queued);
    await pool.query(
      `UPDATE jobs
          SET max_attempts = 1, created_at = '1994-01-01T00:00:00Z'
        WHERE id = $1`,
      [queued.jobId],
    );

    const workerId = "crashed-monitor";
    const lease = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId,
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 30,
      },
    });
    assert.equal(lease.status, 200);
    assert.equal(lease.body.id, queued.jobId);
    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [queued.jobId],
    );

    const maintenance = await request("/v1/monitoring/tick", {
      method: "POST",
      body: { limit: 100 },
    });
    assert.ok(maintenance.body.deadLettered >= 1);
    assert.ok(maintenance.body.reconciledMonitorFailures >= 1);
    const failedRun = await pool.query(
      "SELECT state, snapshot, cost_units FROM monitoring_runs WHERE job_id = $1",
      [queued.jobId],
    );
    assert.equal(failedRun.rowCount, 1);
    assert.equal(failedRun.rows[0].state, "FAILED");
    assert.equal(
      failedRun.rows[0].snapshot.code,
      "WORKER_RETRY_EXHAUSTED",
    );

    await request(`/v1/monitors/${policy.body.id}/enable`, {
      method: "POST",
      body: {},
    });
    const secondTick = await request("/v1/monitoring/tick", {
      method: "POST",
      body: { limit: 100 },
    });
    const second = secondTick.body.queued.find(
      (item) => item.policyId === policy.body.id,
    );
    assert.ok(second);
    await pool.query(
      "UPDATE jobs SET created_at = '1994-01-02T00:00:00Z' WHERE id = $1",
      [second.jobId],
    );
    const secondWorker = "monitor-after-crash";
    const secondLease = await request("/v1/worker/jobs/lease", {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: secondWorker,
        capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
        leaseSeconds: 60,
      },
    });
    assert.equal(secondLease.body.id, second.jobId);

    const baseline = await request(
      `/v1/worker/milestone-b/jobs/${second.jobId}/monitoring-run`,
      {
        method: "POST",
        token: WORKER_TOKEN,
        body: {
          workerId: secondWorker,
          policyId: policy.body.id,
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
    await request(`/v1/worker/jobs/${second.jobId}/complete`, {
      method: "POST",
      token: WORKER_TOKEN,
      body: {
        workerId: secondWorker,
        state: "SUCCEEDED",
        output: {},
      },
    });
  },
);

test(
  "monitor validation bounds budgets and input size",
  { skip: !enabled },
  async () => {
    const host = "monitor-validation-b.example.com";
    const target = await request("/v1/targets", {
      method: "POST",
      body: {
        organizationName: "Monitor Validation B",
        baseUrl: `https://${host}`,
        authorization: { mode: "PUBLIC_QA_ONLY", allowedHosts: [host] },
      },
    });
    for (const dailyBudgetUnits of [0, -1, 100001]) {
      const invalid = await request(
        `/v1/targets/${target.body.id}/monitors`,
        {
          method: "POST",
          body: {
            capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
            requestedUrl: `https://${host}/`,
            cadenceMinutes: 5,
            dailyBudgetUnits,
          },
        },
      );
      assert.equal(invalid.status, 400);
    }
    const invalidInput = await request(
      `/v1/targets/${target.body.id}/monitors`,
      {
        method: "POST",
        body: {
          capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
          requestedUrl: `https://${host}/`,
          cadenceMinutes: 5,
          dailyBudgetUnits: 1,
          input: "not-an-object",
        },
      },
    );
    assert.equal(invalidInput.status, 400);

    const oversizedInput = await request(
      `/v1/targets/${target.body.id}/monitors`,
      {
        method: "POST",
        body: {
          capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
          requestedUrl: `https://${host}/`,
          cadenceMinutes: 5,
          dailyBudgetUnits: 1,
          input: { payload: "x".repeat(70 * 1024) },
        },
      },
    );
    assert.equal(oversizedInput.status, 400);
  },
);

test(
  "operational metrics use an exact rolling 24-hour error boundary",
  { skip: !enabled },
  async () => {
    const before = await request("/v1/ops/metrics");
    assert.equal(before.status, 200);
    await pool.query(
      `INSERT INTO operational_events
         (component, event_type, severity, payload, created_at)
       VALUES
         ('test','OLD_ERROR','ERROR','{}'::jsonb, now() - interval '25 hours'),
         ('test','RECENT_ERROR','ERROR','{}'::jsonb, now() - interval '23 hours')`,
    );
    const after = await request("/v1/ops/metrics");
    assert.equal(after.status, 200);
    assert.equal(after.body.errors24h, before.body.errors24h + 1);
    assert.ok(after.body.usageToday.costUnits >= 0);
    assert.ok(after.body.usageToday.jobCount >= 0);
  },
);
