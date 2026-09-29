import test, { after } from "node:test";
import assert from "node:assert/strict";

import { closePool, pool } from "../src/repository.js";
import { createServer } from "../src/server.js";

const enabled = Boolean(process.env.DATABASE_URL);
const ORCHESTRATOR_TOKEN = "platform-orchestrator";
const WORKER_TOKEN = "platform-worker";
const BOOTSTRAP_TOKEN = "platform-bootstrap-secret";

let server;
let baseUrl;

if (enabled) {
  server = createServer({
    orchestratorToken: ORCHESTRATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    bootstrapToken: BOOTSTRAP_TOKEN,
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

async function request(path, {
  method = "GET",
  body,
  token,
  headers = {},
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    headers: response.headers,
    body:
      response.status === 204
        ? null
        : await response.json().catch(() => null),
    text:
      response.headers.get("content-type")?.includes("text/html")
        ? await response.clone().text().catch(() => "")
        : "",
  };
}

function targetBody(host, organizationName = host) {
  return {
    organizationName,
    baseUrl: `https://${host}/`,
    authorization: {
      mode: "PUBLIC_QA_ONLY",
      allowedHosts: [host],
      allowedCapabilities: [
        "PUBLIC_HTTP_OBSERVE",
        "BROWSER_QA",
        "PERFORMANCE_AUDIT",
      ],
    },
  };
}

test(
  "platform tenancy, RBAC, API keys and quotas fail closed",
  { skip: !enabled },
  async (t) => {
    await pool.query("DELETE FROM platform_sessions");
    await pool.query("DELETE FROM workspace_invites");
    await pool.query("DELETE FROM workspace_memberships");
    await pool.query("DELETE FROM platform_api_keys");
    await pool.query("DELETE FROM platform_users");
    await pool.query(
      `DELETE FROM workspaces
        WHERE id <> '00000000-0000-4000-8000-000000000001'`,
    );

    let ownerToken;
    let workspaceA;
    let workspaceB;
    let targetA;

    await t.test("console is public but hardened", async () => {
      const response = await fetch(`${baseUrl}/console`);
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-security-policy") || "",
        /frame-ancestors 'none'/,
      );
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const html = await response.text();
      assert.match(html, /Mecordxn8n Control Center/);
      assert.match(html, /\/console\/styles\/v2\.css/);

      const deepLink = await fetch(
        `${baseUrl}/console/findings/00000000-0000-4000-8000-000000000001`,
      );
      assert.equal(deepLink.status, 200);
      assert.match(await deepLink.text(), /Mecordxn8n Control Center/);

      const moduleResponse = await fetch(`${baseUrl}/console/core/router.js`);
      assert.equal(moduleResponse.status, 200);
      assert.match(
        moduleResponse.headers.get("content-type") || "",
        /text\/javascript/,
      );
      assert.match(await moduleResponse.text(), /parseConsoleRoute/);

      const traversal = await fetch(
        `${baseUrl}/console/core/%2e%2e/%2e%2e/package.json`,
      );
      assert.notEqual(traversal.status, 200);
    });

    await t.test("owner bootstrap is one-time and login is opaque", async () => {
      const bootstrap = await request("/v1/platform/bootstrap", {
        method: "POST",
        token: BOOTSTRAP_TOKEN,
        body: {
          email: "owner@example.test",
          displayName: "Owner",
          password: "Correct-Horse-Battery-1",
          workspaceName: "Workspace Alpha",
          workspaceSlug: "workspace-alpha",
        },
      });
      assert.equal(bootstrap.status, 201);
      assert.match(bootstrap.body.token, /^mcs_/);
      ownerToken = bootstrap.body.token;
      workspaceA = bootstrap.body.workspace;

      const replay = await request("/v1/platform/bootstrap", {
        method: "POST",
        token: BOOTSTRAP_TOKEN,
        body: {
          email: "second@example.test",
          displayName: "Second",
          password: "Correct-Horse-Battery-2",
          workspaceName: "Second",
          workspaceSlug: "second",
        },
      });
      assert.equal(replay.status, 409);
      assert.equal(replay.body.error, "ALREADY_BOOTSTRAPPED");

      const wrong = await request("/v1/platform/auth/login", {
        method: "POST",
        body: {
          email: "owner@example.test",
          password: "Wrong-Password-000",
        },
      });
      assert.equal(wrong.status, 401);

      const login = await request("/v1/platform/auth/login", {
        method: "POST",
        body: {
          email: "OWNER@example.test",
          password: "Correct-Horse-Battery-1",
        },
      });
      assert.equal(login.status, 200);
      assert.match(login.body.token, /^mcs_/);
      ownerToken = login.body.token;
    });

    await t.test("owner can create an isolated second workspace", async () => {
      const created = await request("/v1/platform/workspaces", {
        method: "POST",
        token: ownerToken,
        body: {
          name: "Workspace Beta",
          slug: "workspace-beta",
        },
      });
      assert.equal(created.status, 201);
      workspaceB = created.body;

      const me = await request("/v1/platform/me", { token: ownerToken });
      assert.equal(me.status, 200);
      assert.equal(me.body.workspaces.length, 2);
    });

    await t.test("workspace targets are isolated and canonical quotas apply", async () => {
      const a = await request(
        `/v1/platform/workspaces/${workspaceA.id}/targets`,
        {
          method: "POST",
          token: ownerToken,
          body: targetBody("alpha.example.test", "Alpha"),
        },
      );
      assert.equal(a.status, 201);
      assert.equal(a.body.workspaceId, workspaceA.id);
      targetA = a.body;

      const b = await request(
        `/v1/platform/workspaces/${workspaceB.id}/targets`,
        {
          method: "POST",
          token: ownerToken,
          body: targetBody("beta.example.test", "Beta"),
        },
      );
      assert.equal(b.status, 201);
      assert.equal(b.body.workspaceId, workspaceB.id);

      const listA = await request(
        `/v1/platform/workspaces/${workspaceA.id}/targets`,
        { token: ownerToken },
      );
      assert.equal(listA.status, 200);
      assert.deepEqual(
        listA.body.targets.map((item) => item.organizationName),
        ["Alpha"],
      );

      await pool.query(
        `UPDATE workspace_subscriptions
            SET plan = 'FREE', status = 'ACTIVE'
          WHERE workspace_id = $1`,
        [workspaceA.id],
      );
      for (const [host, name] of [
        ["alpha-two.example.test", "Alpha Two"],
        ["alpha-three.example.test", "Alpha Three"],
      ]) {
        const created = await request(
          `/v1/platform/workspaces/${workspaceA.id}/targets`,
          {
            method: "POST",
            token: ownerToken,
            body: targetBody(host, name),
          },
        );
        assert.equal(created.status, 201);
      }
      const over = await request(
        `/v1/platform/workspaces/${workspaceA.id}/targets`,
        {
          method: "POST",
          token: ownerToken,
          body: targetBody("alpha-four.example.test", "Alpha Four"),
        },
      );
      assert.equal(over.status, 409);
      assert.equal(over.body.error, "PLAN_TARGET_LIMIT");
    });

    await t.test("approval context is tenant-bound and hides remediation project roots", async () => {
      const inserted = await pool.query(
        `INSERT INTO approval_requests (
           target_id, action_type, payload, requested_by, expires_at
         )
         VALUES ($1, 'SOURCE_REMEDIATION', $2::jsonb, 'owner@example.test', now() + interval '2 hours')
         RETURNING id`,
        [targetA.id, JSON.stringify({ projectRoot: "C:\\Sensitive\\CustomerRepo" })],
      );
      const approvalId = inserted.rows[0].id;

      const context = await request(
        `/v1/platform/workspaces/${workspaceA.id}/approvals/${approvalId}`,
        { token: ownerToken },
      );
      assert.equal(context.status, 200);
      assert.equal(context.body.approval.actionType, "SOURCE_REMEDIATION");
      assert.equal(context.body.approval.payloadSummary.projectRootConfigured, true);
      assert.equal(context.body.target.id, targetA.id);
      assert.doesNotMatch(JSON.stringify(context.body), /Sensitive|CustomerRepo|projectRoot":/);

      const crossTenant = await request(
        `/v1/platform/workspaces/${workspaceB.id}/approvals/${approvalId}`,
        { token: ownerToken },
      );
      assert.equal(crossTenant.status, 404);
    });

    let viewerToken;
    await t.test("invite-only viewer cannot cross tenants or mutate", async () => {
      await pool.query(
        `UPDATE workspace_subscriptions
            SET plan = 'TEAM'
          WHERE workspace_id = $1`,
        [workspaceA.id],
      );
      const invite = await request(
        `/v1/platform/workspaces/${workspaceA.id}/invites`,
        {
          method: "POST",
          token: ownerToken,
          body: { email: "viewer@example.test", role: "VIEWER" },
        },
      );
      assert.equal(invite.status, 201);
      assert.match(invite.body.inviteToken, /^mci_/);

      const accepted = await request("/v1/platform/auth/accept-invite", {
        method: "POST",
        body: {
          inviteToken: invite.body.inviteToken,
          displayName: "Viewer",
          password: "Viewer-Password-1234",
        },
      });
      assert.equal(accepted.status, 200);
      viewerToken = accepted.body.token;

      const readA = await request(
        `/v1/platform/workspaces/${workspaceA.id}/overview`,
        { token: viewerToken },
      );
      assert.equal(readA.status, 200);

      const readB = await request(
        `/v1/platform/workspaces/${workspaceB.id}/overview`,
        { token: viewerToken },
      );
      assert.equal(readB.status, 403);

      const mutate = await request(
        `/v1/platform/workspaces/${workspaceA.id}/targets`,
        {
          method: "POST",
          token: viewerToken,
          body: targetBody("viewer-write.example.test"),
        },
      );
      assert.equal(mutate.status, 403);
    });

    await t.test("scoped API keys cannot escalate or cross workspaces", async () => {
      const key = await request(
        `/v1/platform/workspaces/${workspaceA.id}/api-keys`,
        {
          method: "POST",
          token: ownerToken,
          body: {
            name: "read-only-ci",
            scopes: ["workspace:read"],
            rateLimitPerHour: 1000,
          },
        },
      );
      assert.equal(key.status, 201);
      assert.match(key.body.secret, /^mck_/);

      const read = await request(
        `/v1/platform/workspaces/${workspaceA.id}/overview`,
        { token: key.body.secret },
      );
      assert.equal(read.status, 200);

      const crossTenant = await request(
        `/v1/platform/workspaces/${workspaceB.id}/overview`,
        { token: key.body.secret },
      );
      assert.equal(crossTenant.status, 403);

      const write = await request(
        `/v1/platform/workspaces/${workspaceA.id}/jobs`,
        {
          method: "POST",
          token: key.body.secret,
          body: {
            targetId: targetA.id,
            jobType: "api-key-forbidden",
            capability: "PERFORMANCE_AUDIT",
            requestedUrl: targetA.baseUrl,
          },
        },
      );
      assert.equal(write.status, 403);
    });

    await t.test("operator job creation consumes usage and run detail stays sanitized", async () => {
      const before = await request(
        `/v1/platform/workspaces/${workspaceA.id}/subscription`,
        { token: ownerToken },
      );
      const job = await request(
        `/v1/platform/workspaces/${workspaceA.id}/jobs`,
        {
          method: "POST",
          token: ownerToken,
          body: {
            targetId: targetA.id,
            jobType: "platform-observe",
            capability: "PUBLIC_HTTP_OBSERVE",
            requestedUrl: `${targetA.baseUrl}?token=RUN-URL-SECRET#private`,
            input: { sentinel: "RUN-INPUT-SECRET" },
          },
        },
      );
      assert.equal(job.status, 201);
      await pool.query(
        `UPDATE jobs
            SET state = 'CANCELLED',
                completed_at = now(),
                output = $2::jsonb,
                error = $3::jsonb
          WHERE id = $1`,
        [
          job.body.id,
          JSON.stringify({ sentinel: "RUN-OUTPUT-SECRET" }),
          JSON.stringify({
            code: "UPSTREAM_TIMEOUT",
            message: "RUN-ERROR-SECRET",
          }),
        ],
      );

      const detail = await request(
        `/v1/platform/workspaces/${workspaceA.id}/jobs/${job.body.id}`,
        { token: ownerToken },
      );
      assert.equal(detail.status, 200);
      assert.equal(detail.body.id, job.body.id);
      assert.equal(detail.body.errorCode, "UPSTREAM_TIMEOUT");
      assert.equal(detail.body.state, "CANCELLED");
      assert.equal(detail.body.requestedUrl.includes("?"), false);
      assert.equal(detail.body.requestedUrl.includes("#"), false);
      assert.doesNotMatch(
        JSON.stringify(detail.body),
        /RUN-(?:URL|INPUT|OUTPUT|ERROR)-SECRET/,
      );

      const crossWorkspaceDetail = await request(
        `/v1/platform/workspaces/${workspaceB.id}/jobs/${job.body.id}`,
        { token: ownerToken },
      );
      assert.equal(crossWorkspaceDetail.status, 404);

      const findingFixture = await pool.query(
        `INSERT INTO findings (
           target_id, first_job_id, last_job_id, fingerprint, category,
           title, severity, confidence, affected_url, evidence, status
         )
         VALUES (
           $1,$2,$2,'platform-repair-fixture','RUNTIME',
           'Repair fixture','HIGH',0.9,$3,$4::jsonb,'VERIFIED'
         )
         RETURNING id`,
        [
          targetA.id,
          job.body.id,
          targetA.baseUrl,
          JSON.stringify({ safe: "finding evidence" }),
        ],
      );
      const remediationFixture = await pool.query(
        `INSERT INTO remediation_requests (
           target_id, finding_id, job_id, project_root, status,
           mcp_request_id, mcp_result, completed_at
         )
         VALUES (
           $1,$2,$3,'C:\\PRIVATE\\CUSTOMER_REPO','FAILED',
           gen_random_uuid(),$4::jsonb,now()
         )
         RETURNING id`,
        [
          targetA.id,
          findingFixture.rows[0].id,
          job.body.id,
          JSON.stringify({
            secret: "MCP-RESULT-SECRET",
            sourcePath: "C:\\PRIVATE\\CUSTOMER_REPO\\src",
          }),
        ],
      );
      await pool.query(
        `INSERT INTO repair_outcomes (
           remediation_request_id, finding_id, pattern_key,
           outcome, summary, lessons
         )
         VALUES ($1,$2,'fixture-pattern','FAILED',$3,$4::jsonb)`,
        [
          remediationFixture.rows[0].id,
          findingFixture.rows[0].id,
          "Safe repair outcome summary",
          JSON.stringify({ hiddenSentinel: "REPAIR-LESSONS-SECRET" }),
        ],
      );

      const repairs = await request(
        `/v1/platform/workspaces/${workspaceA.id}/repairs`,
        { token: ownerToken },
      );
      assert.equal(repairs.status, 200);
      assert.equal(
        repairs.body.repairs.some(
          (item) => item.id === remediationFixture.rows[0].id,
        ),
        true,
      );
      assert.doesNotMatch(
        JSON.stringify(repairs.body),
        /PRIVATE|CUSTOMER_REPO|MCP-RESULT-SECRET|REPAIR-LESSONS-SECRET/,
      );

      const repairDetail = await request(
        `/v1/platform/workspaces/${workspaceA.id}/repairs/${remediationFixture.rows[0].id}`,
        { token: ownerToken },
      );
      assert.equal(repairDetail.status, 200);
      assert.equal(repairDetail.body.outcome.status, "FAILED");
      assert.equal(
        repairDetail.body.outcome.summary,
        "Safe repair outcome summary",
      );
      assert.doesNotMatch(
        JSON.stringify(repairDetail.body),
        /PRIVATE|CUSTOMER_REPO|MCP-RESULT-SECRET|REPAIR-LESSONS-SECRET/,
      );

      const crossWorkspaceRepair = await request(
        `/v1/platform/workspaces/${workspaceB.id}/repairs/${remediationFixture.rows[0].id}`,
        { token: ownerToken },
      );
      assert.equal(crossWorkspaceRepair.status, 404);

      const after = await request(
        `/v1/platform/workspaces/${workspaceA.id}/subscription`,
        { token: ownerToken },
      );
      assert.equal(
        Number(after.body.usage.jobs_created),
        Number(before.body.usage.jobs_created || 0) + 1,
      );
    });

    await t.test("viewer cannot change retention and logout revokes session", async () => {
      const denied = await request(
        `/v1/platform/workspaces/${workspaceA.id}/retention`,
        {
          method: "POST",
          token: viewerToken,
          body: { retentionDays: 30 },
        },
      );
      assert.equal(denied.status, 403);

      const updated = await request(
        `/v1/platform/workspaces/${workspaceA.id}/retention`,
        {
          method: "POST",
          token: ownerToken,
          body: { retentionDays: 30 },
        },
      );
      assert.equal(updated.status, 200);
      assert.equal(updated.body.retention_days, 30);

      const logout = await request("/v1/platform/auth/logout", {
        method: "POST",
        token: viewerToken,
      });
      assert.equal(logout.status, 204);

      const expired = await request("/v1/platform/me", {
        token: viewerToken,
      });
      assert.equal(expired.status, 401);
    });
  },
);
