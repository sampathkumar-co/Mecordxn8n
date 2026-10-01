import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.PLATFORM_AUTH_KEY ||= "tenant-idor-auth-key-with-at-least-32-characters";

import { createServer } from "../src/server.js";
import { closePool, pool } from "../src/repository.js";

const enabled = Boolean(process.env.DATABASE_URL);
let server;
let baseUrl;

if (enabled) {
  server = createServer({
    orchestratorToken: "tenant-idor-orchestrator",
    workerToken: "tenant-idor-worker",
    bootstrapToken: "tenant-idor-bootstrap",
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

async function request(path, { method = "GET", token, body } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, body: payload, text };
}

async function signup(label) {
  const suffix = randomUUID().slice(0, 8);
  const safe = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const response = await request("/v1/platform/auth/signup", {
    method: "POST",
    body: {
      email: `${safe}-${suffix}@example.test`,
      displayName: label,
      password: "Tenant-IDOR-Password-12345",
      workspaceName: `${label} ${suffix}`,
      workspaceSlug: `${safe}-${suffix}`,
    },
  });
  assert.equal(response.status, 201);
  return response.body;
}

async function target(token, workspaceId, host) {
  const response = await request(
    `/v1/platform/workspaces/${workspaceId}/targets`,
    {
      method: "POST",
      token,
      body: {
        organizationName: host,
        baseUrl: `https://${host}/`,
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: [host],
          allowedCapabilities: ["PUBLIC_HTTP_OBSERVE", "BROWSER_QA"],
        },
      },
    },
  );
  assert.equal(response.status, 201);
  return response.body;
}

test(
  "workspace object UUIDs cannot be used as cross-tenant IDORs",
  { skip: !enabled },
  async () => {
    const alpha = await signup("Alpha IDOR");
    const beta = await signup("Beta IDOR");

    const alphaTarget = await target(
      alpha.token,
      alpha.workspace.id,
      "alpha-idor.example.test",
    );
    const betaTarget = await target(
      beta.token,
      beta.workspace.id,
      "beta-idor.example.test",
    );

    const authorization = await pool.query(
      `SELECT id
         FROM authorizations
        WHERE target_id = $1
          AND revoked_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [betaTarget.id],
    );
    assert.equal(authorization.rowCount, 1);

    const seededJob = await pool.query(
      `INSERT INTO jobs (
         target_id, authorization_id, job_type, capability,
         requested_url, input, state, completed_at
       )
       VALUES (
         $1,$2,'idor-seed','BROWSER_QA',$3,'{}'::jsonb,'SUCCEEDED',now()
       )
       RETURNING id`,
      [betaTarget.id, authorization.rows[0].id, betaTarget.baseUrl],
    );
    const seededJobId = seededJob.rows[0].id;

    const finding = await pool.query(
      `INSERT INTO findings (
         target_id, first_job_id, last_job_id,
         fingerprint, category, title, severity,
         confidence, affected_url, evidence, verification_state, status
       )
       VALUES (
         $1,$2,$2,$3,'browser','Beta private finding','HIGH',
         0.99,$4,'{"proof":"private-beta"}'::jsonb,'VERIFIED','VERIFIED'
       )
       RETURNING id`,
      [
        betaTarget.id,
        seededJobId,
        "idor-" + randomUUID(),
        betaTarget.baseUrl,
      ],
    );
    const findingId = finding.rows[0].id;

    const verification = await pool.query(
      `INSERT INTO finding_verifications (
         finding_id, job_id, status, attempts, matched_attempts,
         confidence, evidence
       )
       VALUES ($1,$2,'VERIFIED',2,2,1.0,'{"private":"verification"}'::jsonb)
       RETURNING id`,
      [findingId, seededJobId],
    );
    const verificationId = verification.rows[0].id;

    const artifactSha = "a".repeat(64);
    await pool.query(
      `INSERT INTO evidence_artifacts (
         target_id, finding_id, verification_id, kind, path,
         sha256, byte_length, metadata
       )
       VALUES ($1,$2,$3,'screenshot',$4,$5,123,'{"tenant":"beta"}'::jsonb)`,
      [
        betaTarget.id,
        findingId,
        verificationId,
        "evidence://sha256/" + artifactSha,
        artifactSha,
      ],
    );

    const report = await pool.query(
      `INSERT INTO reports (target_id, kind, status, markdown, summary)
       VALUES ($1,'CLIENT_PROPOSAL','READY','beta private report','{"tenant":"beta"}'::jsonb)
       RETURNING id`,
      [betaTarget.id],
    );

    const opportunity = await pool.query(
      `INSERT INTO commercial_opportunities (
         target_id, primary_finding_id, source_report_id, title, state,
         opportunity_score, estimated_value_minor, currency
       )
       VALUES ($1,$2,$3,'Beta private opportunity','QUALIFIED',91,10000,'USD')
       RETURNING id`,
      [betaTarget.id, findingId, report.rows[0].id],
    );

    const crossWorkspace = await request(
      `/v1/platform/workspaces/${beta.workspace.id}/findings/${findingId}`,
      { token: alpha.token },
    );
    assert.equal(crossWorkspace.status, 403);

    const findingIdor = await request(
      `/v1/platform/workspaces/${alpha.workspace.id}/findings/${findingId}`,
      { token: alpha.token },
    );
    assert.equal(findingIdor.status, 404);
    assert.equal(findingIdor.text.includes(artifactSha), false);
    assert.equal(findingIdor.text.includes("private-beta"), false);

    const reportIdor = await request(
      `/v1/platform/workspaces/${alpha.workspace.id}/reports?targetId=${betaTarget.id}`,
      { token: alpha.token },
    );
    assert.equal(reportIdor.status, 200);
    assert.deepEqual(reportIdor.body.reports, []);
    assert.equal(reportIdor.text.includes(report.rows[0].id), false);

    const opportunityIdor = await request(
      `/v1/platform/workspaces/${alpha.workspace.id}/opportunities/${opportunity.rows[0].id}`,
      { token: alpha.token },
    );
    assert.equal(opportunityIdor.status, 404);
    assert.equal(opportunityIdor.text.includes("Beta private opportunity"), false);

    const integrationCrossTenant = await request(
      `/v1/platform/workspaces/${beta.workspace.id}/integrations`,
      { token: alpha.token },
    );
    assert.equal(integrationCrossTenant.status, 403);

    const ownTargets = await request(
      `/v1/platform/workspaces/${alpha.workspace.id}/targets`,
      { token: alpha.token },
    );
    assert.equal(ownTargets.status, 200);
    assert.ok(ownTargets.body.targets.some((item) => item.id === alphaTarget.id));
    assert.equal(
      ownTargets.body.targets.some((item) => item.id === betaTarget.id),
      false,
    );
  },
);
