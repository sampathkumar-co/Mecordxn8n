import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.PLATFORM_MASTER_KEY ||= "ui-v2-platform-master-key-that-is-long-enough";

import { createServer } from "../src/server.js";
import { closePool, pool } from "../src/repository.js";
import {
  createIntegrationConnection,
  enqueueWorkspaceIntegrationEvent,
} from "../src/integrations/repository.js";

const enabled = Boolean(process.env.DATABASE_URL);
const server = enabled
  ? createServer({
      orchestratorToken: "ui-v2-platform-orchestrator",
      workerToken: "ui-v2-platform-worker",
      bootstrapToken: "ui-v2-platform-bootstrap",
    })
  : null;
let baseUrl;

if (server) {
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

async function request(path, { method = "GET", body, token } = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

async function signup(prefix) {
  const suffix = randomUUID().slice(0, 8);
  const response = await request("/v1/platform/auth/signup", {
    method: "POST",
    body: {
      email: `${prefix}-${suffix}@example.test`,
      displayName: "UI V2 Owner",
      password: "UI-V2-Password-12345",
      workspaceName: `UI V2 ${suffix}`,
      workspaceSlug: `ui-v2-${suffix}`,
    },
  });
  assert.equal(response.status, 201);
  return response.body;
}

test("UI V2 access inventory exposes no session tokens and supports self-session revocation", { skip: !enabled }, async () => {
  const account = await signup("access");
  const firstToken = account.token;
  const workspaceId = account.workspace.id;

  const second = await request("/v1/platform/auth/login", {
    method: "POST",
    body: {
      email: account.user.email,
      password: "UI-V2-Password-12345",
    },
  });
  assert.equal(second.status, 200);

  const firstSessions = await request("/v1/platform/sessions", {
    token: firstToken,
  });
  assert.equal(firstSessions.status, 200);
  assert.ok(firstSessions.body.sessions.length >= 2);
  assert.equal(JSON.stringify(firstSessions.body).includes(firstToken), false);
  assert.equal(JSON.stringify(firstSessions.body).includes(second.body.token), false);
  assert.ok(
    firstSessions.body.sessions.every((item) =>
      !Object.hasOwn(item, "tokenHash") && !Object.hasOwn(item, "token_hash")
    ),
  );

  const secondSessions = await request("/v1/platform/sessions", {
    token: second.body.token,
  });
  const secondSessionId = secondSessions.body.currentSessionId;
  const revoked = await request(
    `/v1/platform/sessions/${secondSessionId}/revoke`,
    { method: "POST", token: firstToken, body: {} },
  );
  assert.equal(revoked.status, 204);

  const denied = await request("/v1/platform/me", {
    token: second.body.token,
  });
  assert.equal(denied.status, 401);

  const invite = await request(
    `/v1/platform/workspaces/${workspaceId}/invites`,
    {
      method: "POST",
      token: firstToken,
      body: { email: `invite-${randomUUID().slice(0,6)}@example.test`, role: "VIEWER" },
    },
  );
  assert.equal(invite.status, 201);

  const invites = await request(
    `/v1/platform/workspaces/${workspaceId}/invites`,
    { token: firstToken },
  );
  assert.equal(invites.status, 200);
  assert.ok(invites.body.invites.some((item) => item.id === invite.body.invite.id));
  assert.equal(JSON.stringify(invites.body).includes(invite.body.inviteToken), false);
});

test("UI V2 workspace report/opportunity projections stay workspace-scoped and omit unsafe detail", { skip: !enabled }, async () => {
  const account = await signup("revenue");
  const token = account.token;
  const workspaceId = account.workspace.id;

  const target = await request(
    `/v1/platform/workspaces/${workspaceId}/targets`,
    {
      method: "POST",
      token,
      body: {
        organizationName: "UI Revenue Target",
        baseUrl: "https://ui-revenue.example.test/",
        authorization: {
          mode: "PUBLIC_QA_ONLY",
          allowedHosts: ["ui-revenue.example.test"],
          allowedCapabilities: ["PUBLIC_HTTP_OBSERVE"],
        },
      },
    },
  );
  assert.equal(target.status, 201);

  const report = await request(
    `/v1/platform/workspaces/${workspaceId}/reports`,
    { method: "POST", token, body: { targetId: target.body.id } },
  );
  assert.equal(report.status, 201);

  const reports = await request(
    `/v1/platform/workspaces/${workspaceId}/reports?limit=20`,
    { token },
  );
  assert.equal(reports.status, 200);
  assert.ok(reports.body.reports.some((item) => item.id === report.body.id));
  assert.ok(
    reports.body.reports.every((item) =>
      !Object.hasOwn(item, "markdown")
    ),
  );

  const opportunity = await pool.query(
    `INSERT INTO commercial_opportunities (
       target_id, source_report_id, title, state,
       opportunity_score, estimated_value_minor, currency
     )
     VALUES ($1,$2,'UI verified opportunity','QUALIFIED',88.5,250000,'USD')
     RETURNING id`,
    [target.body.id, report.body.id],
  );

  const detail = await request(
    `/v1/platform/workspaces/${workspaceId}/opportunities/${opportunity.rows[0].id}`,
    { token },
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.body.opportunity.title, "UI verified opportunity");
  assert.equal(detail.body.opportunity.opportunity_score, 88.5);
  assert.ok(Array.isArray(detail.body.actions));
  assert.ok(Array.isArray(detail.body.revenueEvents));
  assert.equal(JSON.stringify(detail.body).includes("destination"), false);
});

test("UI V2 integration recovery route exposes state but never outbox payload or provider secrets", { skip: !enabled }, async () => {
  const account = await signup("integrations");
  const token = account.token;
  const workspaceId = account.workspace.id;
  await pool.query(
    `UPDATE workspace_subscriptions
        SET plan = 'BUSINESS', status = 'ACTIVE'
      WHERE workspace_id = $1`,
    [workspaceId],
  );

  const connection = await createIntegrationConnection({
    workspaceId,
    provider: "GITHUB",
    name: "UI GitHub",
    config: {
      token: "super-secret-github-token",
      owner: "example",
      repo: "repo",
      webhookSecret: "secret-webhook-value",
    },
    subscribedEvents: ["system.test"],
    createdBy: account.user.id,
  });

  await enqueueWorkspaceIntegrationEvent({
    workspaceId,
    eventType: "system.test",
    payload: {
      message: "visible only to worker",
      secretMarker: "OUTBOX_SECRET_MARKER",
    },
    idempotencyKey: "ui-v2-safe-delivery",
  });

  const deliveries = await request(
    `/v1/platform/workspaces/${workspaceId}/integrations/deliveries`,
    { token },
  );
  assert.equal(deliveries.status, 200);
  assert.equal(deliveries.body.deliveries.length, 1);
  const serialized = JSON.stringify(deliveries.body);
  assert.equal(serialized.includes("OUTBOX_SECRET_MARKER"), false);
  assert.equal(serialized.includes("super-secret-github-token"), false);
  assert.equal(Object.hasOwn(deliveries.body.deliveries[0], "payload"), false);

  const integrations = await request(
    `/v1/platform/workspaces/${workspaceId}/integrations`,
    { token },
  );
  assert.equal(integrations.status, 200);
  assert.ok(integrations.body.integrations.some((item) => item.id === connection.id));
  assert.equal(JSON.stringify(integrations.body).includes("super-secret-github-token"), false);
});
