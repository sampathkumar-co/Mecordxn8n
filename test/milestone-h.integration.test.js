import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { createServer } from "../src/server.js";
import { closePool, pool } from "../src/repository.js";
import { completeDomainVerification } from "../src/milestone-h/repository.js";

const enabled = Boolean(process.env.DATABASE_URL);
const ORCHESTRATOR_TOKEN = "milestone-h-orchestrator-token";
const WORKER_TOKEN = "milestone-h-worker-token";
let server;
let baseUrl;

if (enabled) {
  server = createServer({
    orchestratorToken: ORCHESTRATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    bootstrapToken: "milestone-h-bootstrap-token",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
}

after(async () => {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (enabled) await closePool();
});

async function request(path, {
  method = "GET",
  body,
  token = null,
} = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

async function signup(prefix = "h") {
  const suffix = randomUUID().slice(0, 8);
  const response = await request("/v1/platform/auth/signup", {
    method: "POST",
    body: {
      email: prefix + "-" + suffix + "@example.test",
      displayName: "Milestone H Owner",
      password: "Milestone-H-password-12345",
      workspaceName: "Milestone H " + suffix,
      workspaceSlug: "h-" + suffix,
    },
  });
  assert.equal(response.status, 201);
  return response.body;
}

test(
  "self-serve launch reaches approved secure report without privileged bypass",
  { skip: !enabled },
  async () => {
    const account = await signup("launch");
    assert.equal(account.workspace.plan, "TEAM");
    assert.ok(account.trialEndsAt);
    const token = account.token;
    const workspaceId = account.workspace.id;

    const onboarding = await request(
      "/v1/platform/workspaces/" + workspaceId + "/onboarding",
      { token },
    );
    assert.equal(onboarding.status, 200);
    assert.equal(onboarding.body.checklist.accountCreated, true);
    assert.equal(onboarding.body.checklist.targetRegistered, false);

    const bypass = await request(
      "/v1/platform/workspaces/" + workspaceId + "/targets",
      {
        method: "POST",
        token,
        body: {
          organizationName: "Bypass attempt",
          baseUrl: "https://bypass.example.test",
          authorization: {
            mode: "CLIENT_AUTHORIZED",
            allowedHosts: ["bypass.example.test"],
            allowedCapabilities: [
              "PUBLIC_HTTP_OBSERVE",
              "BROWSER_QA",
              "SOURCE_REMEDIATION",
            ],
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        },
      },
    );
    assert.equal(bypass.status, 400);

    const targetResponse = await request(
      "/v1/platform/workspaces/" + workspaceId + "/targets",
      {
        method: "POST",
        token,
        body: {
          organizationName: "Launch target",
          baseUrl: "https://launch.example.test",
          authorization: {
            mode: "PUBLIC_QA_ONLY",
            allowedHosts: ["launch.example.test"],
            allowedCapabilities: ["PUBLIC_HTTP_OBSERVE", "BROWSER_QA"],
          },
        },
      },
    );
    assert.equal(targetResponse.status, 201);
    const targetId = targetResponse.body.id;

    const preVerifyUpgrade = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/targets/" + targetId + "/authorization-center",
      {
        method: "POST",
        token,
        body: {
          mode: "CLIENT_AUTHORIZED",
          allowedHosts: ["launch.example.test"],
          allowedCapabilities: [
            "PUBLIC_HTTP_OBSERVE",
            "BROWSER_QA",
            "SOURCE_REMEDIATION",
          ],
          evidenceReference: "signed-client-scope-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    );
    assert.equal(preVerifyUpgrade.status, 409);
    assert.equal(preVerifyUpgrade.body.error, "DOMAIN_VERIFICATION_REQUIRED");

    const challenge = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/targets/" + targetId + "/domain-verification",
      { method: "POST", token, body: {} },
    );
    assert.equal(challenge.status, 201);
    assert.match(challenge.body.challenge, /^mecordxn8n-verification=/);

    await completeDomainVerification({
      workspaceId,
      verificationId: challenge.body.id,
      matched: true,
    });

    const upgraded = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/targets/" + targetId + "/authorization-center",
      {
        method: "POST",
        token,
        body: {
          mode: "CLIENT_AUTHORIZED",
          allowedHosts: ["launch.example.test"],
          allowedCapabilities: [
            "PUBLIC_HTTP_OBSERVE",
            "BROWSER_QA",
            "SOURCE_REMEDIATION",
          ],
          evidenceReference: "signed-client-scope-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    );
    assert.equal(upgraded.status, 200);
    assert.equal(upgraded.body.mode, "CLIENT_AUTHORIZED");

    const assessed = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/targets/" + targetId + "/assess",
      { method: "POST", token, body: {} },
    );
    assert.equal(assessed.status, 202);
    assert.ok(assessed.body.jobs.http);
    assert.ok(assessed.body.jobs.browser);

    await pool.query(
      `UPDATE jobs
          SET state = 'SUCCEEDED', completed_at = now(), output = '{}'::jsonb
        WHERE id = ANY($1::uuid[])`,
      [[assessed.body.jobs.http.id, assessed.body.jobs.browser.id]],
    );

    const finalizationRuns = await Promise.all([
      request("/v1/maintenance/onboarding", {
        method: "POST",
        token: ORCHESTRATOR_TOKEN,
        body: {},
      }),
      request("/v1/maintenance/onboarding", {
        method: "POST",
        token: ORCHESTRATOR_TOKEN,
        body: {},
      }),
    ]);
    assert.ok(finalizationRuns.every((item) => item.status === 200));
    assert.equal(
      finalizationRuns.reduce(
        (sum, item) => sum + Number(item.body.finalized || 0),
        0,
      ),
      1,
    );
    const reportResult = finalizationRuns.find(
      (item) => item.body.reports?.length > 0,
    );
    const reportId = reportResult.body.reports[0].reportId;
    const reportCount = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM reports
        WHERE target_id = $1 AND kind = 'CLIENT_PROPOSAL'`,
      [targetId],
    );
    assert.equal(reportCount.rows[0].count, 1);

    const refreshed = await request(
      "/v1/platform/workspaces/" + workspaceId + "/onboarding",
      { token },
    );
    assert.equal(refreshed.body.status, "READY");
    assert.equal(refreshed.body.firstReportId, reportId);

    const preReleaseShare = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/reports/" + reportId + "/share",
      { method: "POST", token, body: { expiresHours: 24 } },
    );
    assert.equal(preReleaseShare.status, 409);
    assert.equal(preReleaseShare.body.error, "REPORT_RELEASE_REQUIRED");

    const release = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/reports/" + reportId + "/request-release",
      { method: "POST", token, body: {} },
    );
    assert.equal(release.status, 202);

    const approved = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/approvals/" + release.body.approval.id + "/approve",
      { method: "POST", token, body: {} },
    );
    assert.ok([200, 201].includes(approved.status));

    const share = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/reports/" + reportId + "/share",
      { method: "POST", token, body: { expiresHours: 24 } },
    );
    assert.equal(share.status, 201);
    assert.match(share.body.token, /^mcr_/);

    const storedShare = await pool.query(
      "SELECT token_hash FROM report_share_links WHERE id = $1",
      [share.body.share.id],
    );
    assert.notEqual(storedShare.rows[0].token_hash, share.body.token);

    const publicReport = await request(
      "/v1/platform/public/reports/" + encodeURIComponent(share.body.token),
    );
    assert.equal(publicReport.status, 200);
    assert.equal(publicReport.body.reportId, reportId);
    assert.equal(
      JSON.stringify(publicReport.body).includes("signed-client-scope-1"),
      false,
    );

    const revokedShare = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/report-shares/" + share.body.share.id + "/revoke",
      { method: "POST", token, body: {} },
    );
    assert.equal(revokedShare.status, 200);
    const afterRevoke = await request(
      "/v1/platform/public/reports/" + encodeURIComponent(share.body.token),
    );
    assert.equal(afterRevoke.status, 404);

    const secondAssessment = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/targets/" + targetId + "/assess",
      { method: "POST", token, body: {} },
    );
    assert.equal(secondAssessment.status, 202);

    const revoke = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/targets/" + targetId + "/authorization/revoke",
      { method: "POST", token, body: {} },
    );
    assert.equal(revoke.status, 200);
    const cancelled = await pool.query(
      `SELECT COUNT(*)::int AS count FROM jobs
        WHERE id = ANY($1::uuid[]) AND state = 'CANCELLED'`,
      [[secondAssessment.body.jobs.http.id, secondAssessment.body.jobs.browser.id]],
    );
    assert.equal(cancelled.rows[0].count, 2);
  },
);

test(
  "expired trial becomes read-only while billing and operator controls remain separate",
  { skip: !enabled },
  async () => {
    const account = await signup("trial");
    const token = account.token;
    const workspaceId = account.workspace.id;

    const target = await request(
      "/v1/platform/workspaces/" + workspaceId + "/targets",
      {
        method: "POST",
        token,
        body: {
          organizationName: "Trial target",
          baseUrl: "https://trial.example.test",
          authorization: {
            mode: "PUBLIC_QA_ONLY",
            allowedHosts: ["trial.example.test"],
            allowedCapabilities: ["PUBLIC_HTTP_OBSERVE"],
          },
        },
      },
    );
    assert.equal(target.status, 201);

    await pool.query(
      `UPDATE workspace_subscriptions
          SET status = 'TRIALING', trial_ends_at = now() - interval '1 minute'
        WHERE workspace_id = $1`,
      [workspaceId],
    );

    const health = await request(
      "/v1/platform/workspaces/" + workspaceId + "/health",
      { token },
    );
    assert.equal(health.status, 200);

    const blockedAssess = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/targets/" + target.body.id + "/assess",
      { method: "POST", token, body: {} },
    );
    assert.equal(blockedAssess.status, 403);

    const billing = await request(
      "/v1/platform/workspaces/" + workspaceId + "/billing/checkout",
      { method: "POST", token, body: { plan: "TEAM" } },
    );
    assert.equal(billing.status, 424);
    assert.equal(billing.body.error, "BILLING_NOT_CONFIGURED");

    const adminDenied = await request("/v1/platform/admin/overview", { token });
    assert.equal(adminDenied.status, 403);

    await pool.query(
      `UPDATE platform_users
          SET is_platform_operator = true
        WHERE email = $1`,
      [account.user.email],
    );
    const adminAllowed = await request("/v1/platform/admin/overview", { token });
    assert.equal(adminAllowed.status, 200);
    assert.ok(adminAllowed.body.summary.active_workspaces >= 1);
  },
);

test(
  "duplicate self-serve signup returns a generic conflict without email enumeration detail",
  { skip: !enabled },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const body = {
      email: "duplicate-" + suffix + "@example.test",
      displayName: "Duplicate Owner",
      password: "Milestone-H-password-12345",
      workspaceName: "Duplicate " + suffix,
      workspaceSlug: "duplicate-" + suffix,
    };
    const first = await request("/v1/platform/auth/signup", {
      method: "POST",
      body,
    });
    assert.equal(first.status, 201);
    const second = await request("/v1/platform/auth/signup", {
      method: "POST",
      body: { ...body, workspaceSlug: "different-" + suffix },
    });
    assert.equal(second.status, 409);
    assert.deepEqual(second.body, { error: "SIGNUP_CONFLICT" });
  },
);

test(
  "all-failed first assessment blocks onboarding and never generates a report",
  { skip: !enabled },
  async () => {
    const account = await signup("failed-assessment");
    const token = account.token;
    const workspaceId = account.workspace.id;
    const target = await request(
      "/v1/platform/workspaces/" + workspaceId + "/targets",
      {
        method: "POST",
        token,
        body: {
          organizationName: "Failed assessment target",
          baseUrl: "https://failed-assessment.example.test",
          authorization: {
            mode: "PUBLIC_QA_ONLY",
            allowedHosts: ["failed-assessment.example.test"],
            allowedCapabilities: ["PUBLIC_HTTP_OBSERVE", "BROWSER_QA"],
          },
        },
      },
    );
    assert.equal(target.status, 201);

    const assessed = await request(
      "/v1/platform/workspaces/" + workspaceId +
        "/targets/" + target.body.id + "/assess",
      { method: "POST", token, body: {} },
    );
    assert.equal(assessed.status, 202);

    await pool.query(
      `UPDATE jobs
          SET state = 'FAILED',
              completed_at = now(),
              error = '{"code":"TEST_WORKER_FAILED"}'::jsonb
        WHERE id = ANY($1::uuid[])`,
      [[assessed.body.jobs.http.id, assessed.body.jobs.browser.id]],
    );

    const maintenance = await request("/v1/maintenance/onboarding", {
      method: "POST",
      token: ORCHESTRATOR_TOKEN,
      body: {},
    });
    assert.equal(maintenance.status, 200);
    assert.equal(maintenance.body.blockedAssessments, 1);
    assert.equal(maintenance.body.finalized, 0);

    const onboarding = await request(
      "/v1/platform/workspaces/" + workspaceId + "/onboarding",
      { token },
    );
    assert.equal(onboarding.status, 200);
    assert.equal(onboarding.body.status, "BLOCKED");
    assert.equal(onboarding.body.blockedReason, "ASSESSMENT_FAILED");
    assert.equal(onboarding.body.firstReportId, null);

    const reportCount = await pool.query(
      "SELECT COUNT(*)::int AS count FROM reports WHERE target_id = $1",
      [target.body.id],
    );
    assert.equal(reportCount.rows[0].count, 0);
  },
);
