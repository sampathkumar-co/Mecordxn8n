import { pool } from "../repository.js";
import { limitsForPlan } from "../platform/plans.js";
import {
  decryptIntegrationConfig,
  encryptIntegrationConfig,
} from "./crypto.js";
import { publicIntegrationConfig } from "./policy.js";

function mapConnection(row, config = null) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    name: row.name,
    status: row.status,
    subscribedEvents: row.subscribed_events || [],
    publicConfig: config ? publicIntegrationConfig(row.provider, config) : {},
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function decryptRow(row) {
  return decryptIntegrationConfig({
    ciphertext: row.config_ciphertext,
    iv: row.config_iv,
    tag: row.config_tag,
    workspaceId: row.workspace_id,
    provider: row.provider,
  });
}

export async function createIntegrationConnection({
  workspaceId,
  provider,
  name,
  config,
  subscribedEvents,
  createdBy = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(
      `SELECT w.id, COALESCE(s.plan, w.plan) AS plan
         FROM workspaces w
         LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
        WHERE w.id = $1
          AND w.status = 'ACTIVE'
        FOR UPDATE OF w`,
      [workspaceId],
    );
    if (workspace.rowCount === 0) {
      const error = new Error("workspace not found");
      error.statusCode = 404;
      error.code = "WORKSPACE_NOT_FOUND";
      throw error;
    }

    const limit = limitsForPlan(workspace.rows[0].plan).integrations;
    if (limit != null) {
      const count = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM integration_connections
          WHERE workspace_id = $1
            AND status <> 'DISABLED'`,
        [workspaceId],
      );
      if (count.rows[0].count >= limit) {
        const error = new Error("workspace integration quota reached");
        error.statusCode = 409;
        error.code = "PLAN_INTEGRATION_LIMIT";
        throw error;
      }
    }

    const encrypted = encryptIntegrationConfig({
      config,
      workspaceId,
      provider,
    });
    const result = await client.query(
      `INSERT INTO integration_connections (
         workspace_id, provider, name, status,
         config_ciphertext, config_iv, config_tag, config_version,
         subscribed_events, created_by
       )
       VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        workspaceId,
        provider,
        name,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        encrypted.version,
        subscribedEvents,
        createdBy,
      ],
    );
    await client.query(
      `INSERT INTO workspace_security_events (
         workspace_id, user_id, event_type, severity, metadata
       )
       VALUES ($1,$2,'INTEGRATION_CREATED','INFO',$3::jsonb)`,
      [
        workspaceId,
        createdBy,
        JSON.stringify({
          connectionId: result.rows[0].id,
          provider,
          events: subscribedEvents,
        }),
      ],
    );
    await client.query("COMMIT");
    return mapConnection(result.rows[0], config);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      error.statusCode = 409;
      error.code = "INTEGRATION_NAME_EXISTS";
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listIntegrationConnections(workspaceId) {
  const result = await pool.query(
    `SELECT *
       FROM integration_connections
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows.map((row) => {
    let config = null;
    try {
      config = decryptRow(row);
    } catch {
      // Corrupt configs remain visible but never expose ciphertext.
    }
    return mapConnection(row, config);
  });
}

export async function getIntegrationConnection(connectionId, workspaceId = null) {
  const result = await pool.query(
    `SELECT *
       FROM integration_connections
      WHERE id = $1
        AND ($2::uuid IS NULL OR workspace_id = $2)`,
    [connectionId, workspaceId],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    connection: mapConnection(row, decryptRow(row)),
    config: decryptRow(row),
    raw: row,
  };
}

export async function setIntegrationConnectionStatus({
  workspaceId,
  connectionId,
  status,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE integration_connections
          SET status = $3,
              updated_at = now()
        WHERE id = $1
          AND workspace_id = $2
        RETURNING *`,
      [connectionId, workspaceId, status],
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    if (status === "DISABLED") {
      await client.query(
        `UPDATE integration_outbox
            SET state = 'CANCELLED',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = now()
          WHERE connection_id = $1
            AND state IN ('PENDING','RUNNING')`,
        [connectionId],
      );
    }
    await client.query("COMMIT");
    let config = null;
    try {
      config = decryptRow(result.rows[0]);
    } catch {}
    return mapConnection(result.rows[0], config);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueWorkspaceIntegrationEvent({
  client = pool,
  workspaceId,
  eventType,
  payload,
  idempotencyKey,
  maxAttempts = 5,
}) {
  const result = await client.query(
    `INSERT INTO integration_outbox (
       workspace_id, connection_id, event_type, payload,
       idempotency_key, max_attempts
     )
     SELECT c.workspace_id, c.id, $2, $3::jsonb, $4, $5
       FROM integration_connections c
      WHERE c.workspace_id = $1
        AND c.status = 'ACTIVE'
        AND $2 = ANY(c.subscribed_events)
     ON CONFLICT (connection_id, idempotency_key)
     DO NOTHING
     RETURNING id, connection_id`,
    [
      workspaceId,
      eventType,
      JSON.stringify(payload || {}),
      String(idempotencyKey).slice(0, 500),
      Math.min(Math.max(Number(maxAttempts) || 5, 1), 10),
    ],
  );
  return result.rows;
}

export async function enqueueTargetIntegrationEvent({
  client = pool,
  targetId,
  eventType,
  payload,
  idempotencyKey,
}) {
  const target = await client.query(
    "SELECT workspace_id FROM targets WHERE id = $1",
    [targetId],
  );
  if (target.rowCount === 0) return [];
  return enqueueWorkspaceIntegrationEvent({
    client,
    workspaceId: target.rows[0].workspace_id,
    eventType,
    payload,
    idempotencyKey,
  });
}

export async function leaseIntegrationDelivery({
  workerId,
  leaseSeconds = 60,
}) {
  const safeSeconds = Math.min(Math.max(Number(leaseSeconds) || 60, 15), 300);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH candidate AS (
         SELECT o.id
           FROM integration_outbox o
           JOIN integration_connections c ON c.id = o.connection_id
          WHERE c.status = 'ACTIVE'
            AND o.attempt_count < o.max_attempts
            AND (
              (
                o.state = 'PENDING'
                AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= now())
              )
              OR (
                o.state = 'RUNNING'
                AND o.lease_expires_at IS NOT NULL
                AND o.lease_expires_at <= now()
              )
            )
          ORDER BY COALESCE(o.next_attempt_at, o.created_at), o.created_at
          FOR UPDATE OF o SKIP LOCKED
          LIMIT 1
       )
       UPDATE integration_outbox o
          SET state = 'RUNNING',
              lease_owner = $1,
              lease_expires_at = now() + ($2 * interval '1 second'),
              attempt_count = o.attempt_count + 1,
              next_attempt_at = NULL,
              updated_at = now()
         FROM candidate
        WHERE o.id = candidate.id
       RETURNING o.*`,
      [workerId, safeSeconds],
    );
    if (result.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }
    const row = result.rows[0];
    const connection = await client.query(
      "SELECT * FROM integration_connections WHERE id = $1",
      [row.connection_id],
    );
    if (connection.rowCount === 0 || connection.rows[0].status !== "ACTIVE") {
      await client.query(
        `UPDATE integration_outbox
            SET state = 'CANCELLED',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      await client.query("COMMIT");
      return null;
    }
    const config = decryptRow(connection.rows[0]);
    await client.query("COMMIT");
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      connectionId: row.connection_id,
      eventType: row.event_type,
      payload: row.payload,
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      provider: connection.rows[0].provider,
      config,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeIntegrationDelivery({
  deliveryId,
  workerId,
  state,
  providerReference = null,
  errorCode = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      `SELECT o.*, c.status AS connection_status
         FROM integration_outbox o
         JOIN integration_connections c ON c.id = o.connection_id
        WHERE o.id = $1
          AND o.state = 'RUNNING'
          AND o.lease_owner = $2
          AND o.lease_expires_at > now()
        FOR UPDATE OF o`,
      [deliveryId, workerId],
    );
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = current.rows[0];

    let resultingState = state;
    let nextAttemptAt = null;
    if (state === "FAILED") {
      if (row.connection_status !== "ACTIVE") {
        resultingState = "CANCELLED";
      } else if (row.attempt_count >= row.max_attempts) {
        resultingState = "DEAD_LETTER";
      } else {
        resultingState = "PENDING";
        const seconds = Math.min(
          1800,
          10 * Math.pow(2, Math.max(row.attempt_count - 1, 0)),
        );
        nextAttemptAt = new Date(Date.now() + seconds * 1000);
      }
    }

    const result = await client.query(
      `UPDATE integration_outbox
          SET state = $3,
              provider_reference = CASE
                WHEN $3 = 'SENT' THEN $4
                ELSE provider_reference
              END,
              last_error_code = CASE
                WHEN $3 IN ('PENDING','DEAD_LETTER') THEN $5
                ELSE NULL
              END,
              next_attempt_at = $6,
              sent_at = CASE WHEN $3 = 'SENT' THEN now() ELSE sent_at END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND lease_owner = $2
        RETURNING *`,
      [
        deliveryId,
        workerId,
        resultingState,
        providerReference,
        errorCode ? String(errorCode).slice(0, 120) : null,
        nextAttemptAt,
      ],
    );

    if (resultingState === "SENT") {
      await client.query(
        `UPDATE integration_connections
            SET last_success_at = now(),
                last_error_code = NULL,
                updated_at = now()
          WHERE id = $1`,
        [row.connection_id],
      );
    } else if (["PENDING", "DEAD_LETTER"].includes(resultingState)) {
      await client.query(
        `UPDATE integration_connections
            SET last_error_at = now(),
                last_error_code = $2,
                status = CASE
                  WHEN $3 = 'DEAD_LETTER' THEN 'ERROR'
                  ELSE status
                END,
                updated_at = now()
          WHERE id = $1`,
        [
          row.connection_id,
          errorCode ? String(errorCode).slice(0, 120) : "DELIVERY_FAILED",
          resultingState,
        ],
      );
    }

    await client.query("COMMIT");
    return {
      id: result.rows[0].id,
      state: result.rows[0].state,
      nextAttemptAt: result.rows[0].next_attempt_at,
      attemptCount: result.rows[0].attempt_count,
      maxAttempts: result.rows[0].max_attempts,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueIntegrationTest({
  workspaceId,
  connectionId,
}) {
  const connection = await pool.query(
    `SELECT id FROM integration_connections
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'ACTIVE'`,
    [connectionId, workspaceId],
  );
  if (connection.rowCount === 0) return null;
  const key = `system.test:${Date.now()}:${connectionId}`;
  const result = await pool.query(
    `INSERT INTO integration_outbox (
       workspace_id, connection_id, event_type, payload, idempotency_key
     )
     VALUES ($1,$2,'system.test',$3::jsonb,$4)
     RETURNING id, state, created_at`,
    [
      workspaceId,
      connectionId,
      JSON.stringify({
        message: "Mecordxn8n integration test",
        generatedAt: new Date().toISOString(),
      }),
      key,
    ],
  );
  return result.rows[0];
}

export async function recordIntegrationWebhookReceipt({
  connectionId,
  providerEventId = null,
  eventType,
  payloadSha256,
  signatureValid,
  processedState = "RECORDED",
}) {
  const result = await pool.query(
    `INSERT INTO integration_webhook_receipts (
       connection_id, provider_event_id, event_type,
       payload_sha256, signature_valid, processed_state
     )
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (connection_id, provider_event_id)
       WHERE provider_event_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [
      connectionId,
      providerEventId,
      String(eventType || "unknown").slice(0, 200),
      payloadSha256,
      Boolean(signatureValid),
      processedState,
    ],
  );
  return result.rows[0] || null;
}

export async function markIntegrationWebhookReceiptProcessed({
  receiptId,
  processedState,
}) {
  const allowed = new Set(["RECORDED", "PROCESSED", "IGNORED", "FAILED"]);
  if (!allowed.has(processedState)) {
    throw new Error("invalid webhook receipt state");
  }
  const result = await pool.query(
    `UPDATE integration_webhook_receipts
        SET processed_state = $2
      WHERE id = $1
      RETURNING *`,
    [receiptId, processedState],
  );
  return result.rows[0] || null;
}

export async function applyStripeSubscriptionEvent({
  workspaceId,
  eventType,
  subscription,
}) {
  const allowedPlans = new Set(["FREE", "TEAM", "BUSINESS", "ENTERPRISE"]);
  const plan = String(
    subscription?.metadata?.plan ||
      subscription?.metadata?.mecord_plan ||
      "FREE",
  ).toUpperCase();
  if (!allowedPlans.has(plan)) {
    const error = new Error("Stripe subscription plan metadata is invalid");
    error.code = "STRIPE_PLAN_INVALID";
    error.statusCode = 400;
    throw error;
  }
  const statusMap = {
    trialing: "TRIALING",
    active: "ACTIVE",
    past_due: "PAST_DUE",
    unpaid: "PAST_DUE",
    canceled: "CANCELLED",
    incomplete_expired: "CANCELLED",
  };
  const status =
    eventType === "customer.subscription.deleted"
      ? "CANCELLED"
      : statusMap[subscription?.status] || "PAST_DUE";
  const seats = Math.min(
    Math.max(
      Number(subscription?.items?.data?.[0]?.quantity || 1),
      1,
    ),
    10000,
  );
  const periodEnd = subscription?.current_period_end
    ? new Date(Number(subscription.current_period_end) * 1000)
    : null;

  const result = await pool.query(
    `INSERT INTO workspace_subscriptions (
       workspace_id, plan, status, provider,
       external_customer_id, external_subscription_id,
       seats, current_period_end
     )
     VALUES ($1,$2,$3,'stripe',$4,$5,$6,$7)
     ON CONFLICT (workspace_id)
     DO UPDATE SET
       plan = EXCLUDED.plan,
       status = EXCLUDED.status,
       provider = EXCLUDED.provider,
       external_customer_id = EXCLUDED.external_customer_id,
       external_subscription_id = EXCLUDED.external_subscription_id,
       seats = EXCLUDED.seats,
       current_period_end = EXCLUDED.current_period_end,
       updated_at = now()
     RETURNING *`,
    [
      workspaceId,
      plan,
      status,
      subscription?.customer ? String(subscription.customer).slice(0, 240) : null,
      subscription?.id ? String(subscription.id).slice(0, 240) : null,
      seats,
      periodEnd,
    ],
  );
  await pool.query(
    `UPDATE workspaces
        SET plan = $2,
            updated_at = now()
      WHERE id = $1`,
    [workspaceId, plan],
  );
  return result.rows[0];
}

export async function enqueueDueRenewalIntegrationEvents(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const services = await pool.query(
    `SELECT s.id, s.target_id, s.opportunity_id, s.renewal_at,
            t.workspace_id
       FROM service_agreements s
       JOIN targets t ON t.id = s.target_id
      WHERE s.status = 'ACTIVE'
        AND s.renewal_at IS NOT NULL
        AND s.renewal_at <= now() + interval '7 days'
      ORDER BY s.renewal_at
      LIMIT $1`,
    [safeLimit],
  );
  let queued = 0;
  for (const service of services.rows) {
    const rows = await enqueueWorkspaceIntegrationEvent({
      workspaceId: service.workspace_id,
      eventType: "service.renewal_due",
      payload: {
        serviceAgreementId: service.id,
        targetId: service.target_id,
        opportunityId: service.opportunity_id,
        renewalAt: service.renewal_at,
      },
      idempotencyKey:
        `service.renewal_due:${service.id}:${new Date(service.renewal_at).toISOString()}`,
    });
    queued += rows.length;
  }
  return queued;
}

export async function getIntegrationMetrics(workspaceId) {
  const [connections, deliveries] = await Promise.all([
    pool.query(
      `SELECT status, COUNT(*)::int AS count
         FROM integration_connections
        WHERE workspace_id = $1
        GROUP BY status`,
      [workspaceId],
    ),
    pool.query(
      `SELECT state, COUNT(*)::int AS count
         FROM integration_outbox
        WHERE workspace_id = $1
          AND created_at >= now() - interval '24 hours'
        GROUP BY state`,
      [workspaceId],
    ),
  ]);
  return {
    connections: Object.fromEntries(
      connections.rows.map((row) => [row.status, row.count]),
    ),
    deliveries24h: Object.fromEntries(
      deliveries.rows.map((row) => [row.state, row.count]),
    ),
  };
}
