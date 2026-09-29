import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

import { createServer } from "../src/server.js";
import { closePool, pool } from "../src/repository.js";
import {
  completeIntegrationDelivery,
  createIntegrationConnection,
  enqueueTargetIntegrationEvent,
  enqueueWorkspaceIntegrationEvent,
  getIntegrationMetrics,
  leaseIntegrationDelivery,
  listIntegrationConnections,
} from "../src/integrations/repository.js";

const enabled = Boolean(process.env.DATABASE_URL);
process.env.PLATFORM_MASTER_KEY ||= "integration-test-master-key-32-characters-minimum";

const ORCHESTRATOR_TOKEN = "integration-orchestrator";
const WORKER_TOKEN = "integration-worker-token";
let server;
let baseUrl;

if (enabled) {
  server = createServer({
    orchestratorToken: ORCHESTRATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    bootstrapToken: "integration-bootstrap",
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

async function workspace(name) {
  const slug = ("integration-" + randomUUID()).slice(0, 50);
  const result = await pool.query(
    `INSERT INTO workspaces (name, slug, plan, status)
     VALUES ($1,$2,'BUSINESS','ACTIVE')
     RETURNING *`,
    [name, slug],
  );
  await pool.query(
    `INSERT INTO workspace_subscriptions (
       workspace_id, plan, status, seats
     ) VALUES ($1,'BUSINESS','ACTIVE',10)`,
    [result.rows[0].id],
  );
  return result.rows[0];
}

test(
  "integration configs stay encrypted and outbox leases/retries fail closed",
  { skip: !enabled },
  async () => {
    const ws = await workspace("Integration Outbox");
    const secret = "github-test-token-do-not-expose";
    const connection = await createIntegrationConnection({
      workspaceId: ws.id,
      provider: "GITHUB",
      name: "GitHub notifications",
      config: {
        token: secret,
        owner: "example",
        repo: "example",
        webhookSecret: "github-webhook-test-secret",
      },
      subscribedEvents: ["system.test", "finding.verified"],
    });

    const listed = await listIntegrationConnections(ws.id);
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes(secret), false);
    assert.equal(listed[0].publicConfig.tokenConfigured, true);

    const raw = await pool.query(
      `SELECT config_ciphertext FROM integration_connections WHERE id = $1`,
      [connection.id],
    );
    assert.equal(raw.rows[0].config_ciphertext.includes(secret), false);

    const queued = await enqueueWorkspaceIntegrationEvent({
      workspaceId: ws.id,
      eventType: "system.test",
      payload: { message: "safe event", secret: undefined },
      idempotencyKey: "system.test:one",
    });
    assert.equal(queued.length, 1);

    const duplicate = await enqueueWorkspaceIntegrationEvent({
      workspaceId: ws.id,
      eventType: "system.test",
      payload: { message: "duplicate" },
      idempotencyKey: "system.test:one",
    });
    assert.equal(duplicate.length, 0);

    const leased = await leaseIntegrationDelivery({
      workerId: "worker-a",
      leaseSeconds: 60,
    });
    assert.equal(leased.id, queued[0].id);
    assert.equal(leased.config.token, secret);

    const secondLease = await leaseIntegrationDelivery({
      workerId: "worker-b",
      leaseSeconds: 60,
    });
    assert.equal(secondLease, null);

    const wrongWorker = await completeIntegrationDelivery({
      deliveryId: leased.id,
      workerId: "worker-b",
      state: "SENT",
      providerReference: "wrong",
    });
    assert.equal(wrongWorker, null);

    const failed = await completeIntegrationDelivery({
      deliveryId: leased.id,
      workerId: "worker-a",
      state: "FAILED",
      errorCode: "HTTP_503",
    });
    assert.equal(failed.state, "PENDING");
    assert.equal(failed.attemptCount, 1);

    await pool.query(
      `UPDATE integration_outbox SET next_attempt_at = now() - interval '1 second'
        WHERE id = $1`,
      [leased.id],
    );
    const retry = await leaseIntegrationDelivery({
      workerId: "worker-b",
      leaseSeconds: 60,
    });
    assert.equal(retry.id, leased.id);
    assert.equal(retry.attemptCount, 2);

    const sent = await completeIntegrationDelivery({
      deliveryId: retry.id,
      workerId: "worker-b",
      state: "SENT",
      providerReference: "provider-123",
    });
    assert.equal(sent.state, "SENT");

    const metrics = await getIntegrationMetrics(ws.id);
    assert.equal(metrics.connections.ACTIVE, 1);
    assert.equal(metrics.deliveries24h.SENT, 1);
  },
);

test(
  "target events stay workspace scoped and enqueue only subscribed connections",
  { skip: !enabled },
  async () => {
    const wsA = await workspace("Integration A");
    const wsB = await workspace("Integration B");
    const a = await createIntegrationConnection({
      workspaceId: wsA.id,
      provider: "GITHUB",
      name: "A",
      config: { token: "token-a", owner: "owner", repo: "repo" },
      subscribedEvents: ["finding.verified"],
    });
    await createIntegrationConnection({
      workspaceId: wsB.id,
      provider: "GITHUB",
      name: "B",
      config: { token: "token-b", owner: "owner", repo: "repo" },
      subscribedEvents: ["finding.verified"],
    });

    const target = await pool.query(
      `INSERT INTO targets (organization_name, base_url, workspace_id)
       VALUES ('Scoped target','https://scope.example.test',$1)
       RETURNING id`,
      [wsA.id],
    );
    const rows = await enqueueTargetIntegrationEvent({
      targetId: target.rows[0].id,
      eventType: "finding.verified",
      payload: { findingId: randomUUID() },
      idempotencyKey: "finding.verified:scoped",
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].connection_id, a.id);

    const cross = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM integration_outbox
        WHERE workspace_id = $1`,
      [wsB.id],
    );
    assert.equal(cross.rows[0].count, 0);
  },
);

test(
  "GitHub webhook signatures and replay receipts are enforced",
  { skip: !enabled },
  async () => {
    const ws = await workspace("GitHub Webhook");
    const webhookSecret = "github-hook-secret-with-enough-entropy";
    const connection = await createIntegrationConnection({
      workspaceId: ws.id,
      provider: "GITHUB",
      name: "GitHub inbound",
      config: {
        token: "github-token",
        owner: "owner",
        repo: "repo",
        webhookSecret,
      },
      subscribedEvents: [],
    });

    const payload = JSON.stringify({ action: "opened" });
    const signature =
      "sha256=" +
      createHmac("sha256", webhookSecret).update(payload).digest("hex");

    const invalid = await fetch(
      `${baseUrl}/v1/integrations/webhooks/${connection.id}/github`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "issues",
          "x-github-delivery": "delivery-invalid",
          "x-hub-signature-256": "sha256=bad",
        },
        body: payload,
      },
    );
    assert.equal(invalid.status, 401);

    const headers = {
      "content-type": "application/json",
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": signature,
    };
    const first = await fetch(
      `${baseUrl}/v1/integrations/webhooks/${connection.id}/github`,
      { method: "POST", headers, body: payload },
    );
    assert.equal(first.status, 202);
    assert.equal((await first.json()).duplicate, false);

    const replay = await fetch(
      `${baseUrl}/v1/integrations/webhooks/${connection.id}/github`,
      { method: "POST", headers, body: payload },
    );
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).duplicate, true);
  },
);

test(
  "Stripe webhooks bind subscriptions to the configured workspace",
  { skip: !enabled },
  async () => {
    const ws = await workspace("Stripe Webhook");
    const other = await workspace("Stripe Other");
    const webhookSecret = "stripe-hook-secret-with-enough-entropy";
    const connection = await createIntegrationConnection({
      workspaceId: ws.id,
      provider: "STRIPE",
      name: "Stripe billing",
      config: { webhookSecret },
      subscribedEvents: [],
    });

    const makeEvent = (id, workspaceId) => ({
      id,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_123",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 86400,
          metadata: {
            workspace_id: workspaceId,
            plan: "BUSINESS",
          },
          items: { data: [{ quantity: 3 }] },
        },
      },
    });

    async function signed(event) {
      const raw = JSON.stringify(event);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac("sha256", webhookSecret)
        .update(timestamp + "." + raw)
        .digest("hex");
      return fetch(
        `${baseUrl}/v1/integrations/webhooks/${connection.id}/stripe`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": `t=${timestamp},v1=${signature}`,
          },
          body: raw,
        },
      );
    }

    const mismatch = await signed(makeEvent("evt_mismatch", other.id));
    assert.equal(mismatch.status, 409);

    const accepted = await signed(makeEvent("evt_ok", ws.id));
    assert.equal(accepted.status, 202);
    const subscription = await pool.query(
      `SELECT plan, status, seats, external_subscription_id
         FROM workspace_subscriptions
        WHERE workspace_id = $1`,
      [ws.id],
    );
    assert.equal(subscription.rows[0].plan, "BUSINESS");
    assert.equal(subscription.rows[0].status, "ACTIVE");
    assert.equal(subscription.rows[0].seats, 3);
    assert.equal(subscription.rows[0].external_subscription_id, "sub_123");

    const replay = await signed(makeEvent("evt_ok", ws.id));
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).duplicate, true);
  },
);
