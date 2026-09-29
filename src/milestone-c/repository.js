import { createHash } from "node:crypto";

import { pool } from "../repository.js";
import { enqueueTargetIntegrationEvent } from "../integrations/repository.js";
import {
  canTransitionOpportunity,
  contactCanActivate,
} from "./policy.js";

function problem(code, message, statusCode = 409) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function mapOpportunity(row) {
  return row
    ? {
        id: row.id,
        targetId: row.target_id,
        primaryFindingId: row.primary_finding_id,
        sourceReportId: row.source_report_id,
        title: row.title,
        state: row.state,
        opportunityScore: Number(row.opportunity_score),
        estimatedValueMinor:
          row.estimated_value_minor == null ? null : Number(row.estimated_value_minor),
        currency: row.currency,
        nextActionAt: row.next_action_at,
        metadata: row.metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function mapContact(row) {
  return row
    ? {
        id: row.id,
        targetId: row.target_id,
        displayName: row.display_name,
        channel: row.channel,
        destination: row.destination,
        consentState: row.consent_state,
        consentSource: row.consent_source,
        consentEvidence: row.consent_evidence,
        consentRecordedAt: row.consent_recorded_at,
        consentExpiresAt: row.consent_expires_at,
        suppressedAt: row.suppressed_at,
        suppressionReason: row.suppression_reason,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function mapAction(row) {
  return row
    ? {
        id: row.id,
        targetId: row.target_id,
        opportunityId: row.opportunity_id,
        contactId: row.contact_id,
        reportId: row.report_id,
        kind: row.kind,
        channel: row.channel,
        state: row.state,
        subject: row.subject,
        body: row.body,
        approvalId: row.approval_id,
        approvedAt: row.approved_at,
        sentAt: row.sent_at,
        deliveredBy: row.delivered_by,
        providerReference: row.provider_reference,
        failureCode: row.failure_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

function destinationHash(channel, destination) {
  const normalized =
    channel === "EMAIL"
      ? destination.trim().toLowerCase()
      : destination.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(`${channel}|${normalized}`).digest("hex");
}

async function ensurePolicy(client, targetId) {
  await client.query(
    `INSERT INTO commercial_policies (target_id)
     VALUES ($1)
     ON CONFLICT (target_id) DO NOTHING`,
    [targetId],
  );
  const result = await client.query(
    `SELECT * FROM commercial_policies WHERE target_id = $1`,
    [targetId],
  );
  return result.rows[0];
}

async function audit(client, targetId, eventType, payload) {
  await client.query(
    `INSERT INTO audit_events (target_id, event_type, payload)
     VALUES ($1,$2,$3::jsonb)`,
    [targetId, eventType, JSON.stringify(payload || {})],
  );
}

export async function createCommercialOpportunity({
  finding,
  sourceReportId = null,
  title = null,
  estimatedValueMinor = null,
  currency = null,
  nextActionAt = null,
  metadata = {},
}) {
  const result = await pool.query(
    `INSERT INTO commercial_opportunities (
       target_id, primary_finding_id, source_report_id, title,
       state, opportunity_score, estimated_value_minor, currency,
       next_action_at, metadata
     )
     VALUES ($1,$2,$3,$4,'NEW',$5,$6,$7,$8,$9::jsonb)
     ON CONFLICT (target_id, primary_finding_id)
       WHERE primary_finding_id IS NOT NULL
     DO UPDATE SET
       source_report_id = COALESCE(
         commercial_opportunities.source_report_id,
         EXCLUDED.source_report_id
       ),
       updated_at = now()
     RETURNING *`,
    [
      finding.targetId,
      finding.id,
      sourceReportId,
      String(title || finding.title || "Verified quality opportunity").slice(0, 240),
      Number(finding.intelligence?.opportunityScore || 0),
      estimatedValueMinor,
      currency,
      nextActionAt,
      JSON.stringify(metadata || {}),
    ],
  );
  return mapOpportunity(result.rows[0]);
}

export async function getCommercialOpportunity(opportunityId) {
  const result = await pool.query(
    "SELECT * FROM commercial_opportunities WHERE id = $1",
    [opportunityId],
  );
  return mapOpportunity(result.rows[0]);
}

export async function listCommercialOpportunities({
  targetId,
  state = null,
  limit = 100,
}) {
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500);
  const result = await pool.query(
    `SELECT *
       FROM commercial_opportunities
      WHERE target_id = $1
        AND ($2::text IS NULL OR state = $2)
      ORDER BY opportunity_score DESC, updated_at DESC
      LIMIT $3`,
    [targetId, state || null, safeLimit],
  );
  return result.rows.map(mapOpportunity);
}

export async function transitionCommercialOpportunity({
  opportunityId,
  nextState,
  nextActionAt = undefined,
  estimatedValueMinor = undefined,
  currency = undefined,
  metadata = undefined,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT * FROM commercial_opportunities WHERE id = $1 FOR UPDATE",
      [opportunityId],
    );
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = current.rows[0];
    if (!canTransitionOpportunity(row.state, nextState)) {
      throw problem(
        "INVALID_OPPORTUNITY_TRANSITION",
        `cannot transition opportunity from ${row.state} to ${nextState}`,
      );
    }

    const result = await client.query(
      `UPDATE commercial_opportunities
          SET state = $2,
              next_action_at = CASE
                WHEN $3::boolean THEN $4::timestamptz
                ELSE next_action_at
              END,
              estimated_value_minor = CASE
                WHEN $5::boolean THEN $6::bigint
                ELSE estimated_value_minor
              END,
              currency = CASE
                WHEN $7::boolean THEN $8::text
                ELSE currency
              END,
              metadata = CASE
                WHEN $9::boolean THEN metadata || $10::jsonb
                ELSE metadata
              END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        opportunityId,
        nextState,
        nextActionAt !== undefined,
        nextActionAt ?? null,
        estimatedValueMinor !== undefined,
        estimatedValueMinor ?? null,
        currency !== undefined,
        currency ?? null,
        metadata !== undefined,
        JSON.stringify(metadata || {}),
      ],
    );
    await audit(client, row.target_id, "COMMERCIAL_OPPORTUNITY_TRANSITIONED", {
      opportunityId,
      from: row.state,
      to: nextState,
    });
    await client.query("COMMIT");
    return mapOpportunity(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createCommercialContact({
  targetId,
  displayName = null,
  channel,
  destination,
  consentState = "UNKNOWN",
  consentSource = null,
  consentEvidence = null,
  consentExpiresAt = null,
}) {
  const hash = destinationHash(channel, destination);
  const result = await pool.query(
    `INSERT INTO commercial_contacts (
       target_id, display_name, channel, destination, destination_hash,
       consent_state, consent_source, consent_evidence,
       consent_recorded_at, consent_expires_at,
       suppressed_at, suppression_reason
     )
     VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       CASE WHEN $6 <> 'UNKNOWN' THEN now() ELSE NULL END,
       $9,
       CASE WHEN $6 IN ('OPTED_OUT','DO_NOT_CONTACT') THEN now() ELSE NULL END,
       CASE WHEN $6 IN ('OPTED_OUT','DO_NOT_CONTACT') THEN 'created suppressed' ELSE NULL END
     )
     ON CONFLICT (target_id, channel, destination_hash)
     DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, commercial_contacts.display_name),
       updated_at = now()
     RETURNING *`,
    [
      targetId,
      displayName,
      channel,
      destination,
      hash,
      consentState,
      consentSource,
      consentEvidence,
      consentExpiresAt,
    ],
  );
  return mapContact(result.rows[0]);
}

export async function getCommercialContact(contactId) {
  const result = await pool.query(
    "SELECT * FROM commercial_contacts WHERE id = $1",
    [contactId],
  );
  return mapContact(result.rows[0]);
}

export async function listCommercialContacts(targetId, limit = 100) {
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500);
  const result = await pool.query(
    `SELECT * FROM commercial_contacts
      WHERE target_id = $1
      ORDER BY updated_at DESC
      LIMIT $2`,
    [targetId, safeLimit],
  );
  return result.rows.map(mapContact);
}

export async function updateCommercialConsent({
  contactId,
  consentState,
  consentSource = null,
  consentEvidence = null,
  consentExpiresAt = null,
  suppressionReason = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT * FROM commercial_contacts WHERE id = $1 FOR UPDATE",
      [contactId],
    );
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = current.rows[0];
    const suppress = ["OPTED_OUT", "DO_NOT_CONTACT"].includes(consentState);
    const updated = await client.query(
      `UPDATE commercial_contacts
          SET consent_state = $2,
              consent_source = $3,
              consent_evidence = $4,
              consent_recorded_at = now(),
              consent_expires_at = $5,
              suppressed_at = CASE WHEN $6 THEN now() ELSE NULL END,
              suppression_reason = CASE WHEN $6 THEN $7 ELSE NULL END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [
        contactId,
        consentState,
        consentSource,
        consentEvidence,
        consentExpiresAt,
        suppress,
        suppressionReason || (suppress ? "consent withdrawn" : null),
      ],
    );

    if (suppress || !contactCanActivate(updated.rows[0]).ok) {
      const blocked = await client.query(
        `UPDATE commercial_actions
            SET state = 'BLOCKED',
                failure_code = 'CONSENT_NO_LONGER_VALID',
                updated_at = now()
          WHERE contact_id = $1
            AND state IN ('DRAFT','PENDING_APPROVAL','APPROVED')
          RETURNING id`,
        [contactId],
      );
      if (blocked.rows.length > 0) {
        await client.query(
          `UPDATE approval_requests
              SET status = 'EXPIRED',
                  decided_at = now(),
                  decision_note = COALESCE(
                    decision_note,
                    'Contact consent no longer permits activation.'
                  )
            WHERE commercial_action_id = ANY($1::uuid[])
              AND status = 'PENDING'`,
          [blocked.rows.map((item) => item.id)],
        );
      }
    }

    await audit(client, row.target_id, "COMMERCIAL_CONSENT_UPDATED", {
      contactId,
      consentState,
    });
    await client.query("COMMIT");
    return mapContact(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getCommercialPolicy(targetId) {
  const client = await pool.connect();
  try {
    return await ensurePolicy(client, targetId);
  } finally {
    client.release();
  }
}

export async function updateCommercialPolicy({
  targetId,
  dailyActivationLimit,
  cooldownHours,
}) {
  const result = await pool.query(
    `INSERT INTO commercial_policies (
       target_id, daily_activation_limit, cooldown_hours
     )
     VALUES ($1,$2,$3)
     ON CONFLICT (target_id)
     DO UPDATE SET
       daily_activation_limit = EXCLUDED.daily_activation_limit,
       cooldown_hours = EXCLUDED.cooldown_hours,
       updated_at = now()
     RETURNING *`,
    [targetId, dailyActivationLimit, cooldownHours],
  );
  return result.rows[0];
}

export async function createCommercialAction({
  opportunityId,
  contactId,
  reportId,
  kind,
  subject = null,
  body,
}) {
  const context = await pool.query(
    `SELECT o.target_id,
            c.target_id AS contact_target_id,
            c.channel,
            r.target_id AS report_target_id,
            r.status AS report_status
       FROM commercial_opportunities o
       JOIN commercial_contacts c ON c.id = $2
       JOIN reports r ON r.id = $3
      WHERE o.id = $1`,
    [opportunityId, contactId, reportId],
  );
  if (context.rowCount === 0) {
    throw problem("COMMERCIAL_CONTEXT_NOT_FOUND", "commercial action context not found", 404);
  }
  const row = context.rows[0];
  if (
    row.target_id !== row.contact_target_id ||
    row.target_id !== row.report_target_id
  ) {
    throw problem("COMMERCIAL_CONTEXT_MISMATCH", "commercial action context crosses targets");
  }
  if (row.report_status !== "APPROVED") {
    throw problem("REPORT_RELEASE_REQUIRED", "report must be approved before external use");
  }

  const result = await pool.query(
    `INSERT INTO commercial_actions (
       target_id, opportunity_id, contact_id, report_id,
       kind, channel, subject, body
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      row.target_id,
      opportunityId,
      contactId,
      reportId,
      kind,
      row.channel,
      subject,
      body,
    ],
  );
  return mapAction(result.rows[0]);
}

export async function getCommercialAction(actionId) {
  const result = await pool.query(
    "SELECT * FROM commercial_actions WHERE id = $1",
    [actionId],
  );
  return mapAction(result.rows[0]);
}

export async function listCommercialActions({
  targetId,
  state = null,
  limit = 100,
}) {
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500);
  const result = await pool.query(
    `SELECT *
       FROM commercial_actions
      WHERE target_id = $1
        AND ($2::text IS NULL OR state = $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [targetId, state || null, safeLimit],
  );
  return result.rows.map(mapAction);
}

async function lockedEligibility(client, actionId, { mutateBlock = false } = {}) {
  const actionLookup = await client.query(
    "SELECT * FROM commercial_actions WHERE id = $1",
    [actionId],
  );
  if (actionLookup.rowCount === 0) {
    return { ok: false, code: "ACTION_NOT_FOUND", statusCode: 404 };
  }
  const basic = actionLookup.rows[0];
  await ensurePolicy(client, basic.target_id);

  const policyResult = await client.query(
    "SELECT * FROM commercial_policies WHERE target_id = $1 FOR UPDATE",
    [basic.target_id],
  );
  const contactResult = await client.query(
    "SELECT * FROM commercial_contacts WHERE id = $1 FOR UPDATE",
    [basic.contact_id],
  );
  const actionResult = await client.query(
    "SELECT * FROM commercial_actions WHERE id = $1 FOR UPDATE",
    [actionId],
  );
  const reportResult = await client.query(
    "SELECT id, target_id, status FROM reports WHERE id = $1",
    [basic.report_id],
  );

  const action = actionResult.rows[0];
  const contact = contactResult.rows[0];
  const policy = policyResult.rows[0];
  const report = reportResult.rows[0];

  if (!action || !contact || !report) {
    return { ok: false, code: "COMMERCIAL_CONTEXT_NOT_FOUND", statusCode: 404 };
  }
  if (
    action.target_id !== contact.target_id ||
    action.target_id !== report.target_id
  ) {
    return { ok: false, code: "COMMERCIAL_CONTEXT_MISMATCH", statusCode: 409 };
  }
  if (report.status !== "APPROVED") {
    return { ok: false, code: "REPORT_RELEASE_REQUIRED", statusCode: 409 };
  }

  const consent = contactCanActivate(contact);
  if (!consent.ok) {
    if (mutateBlock && !["SENT", "FAILED", "CANCELLED", "BLOCKED"].includes(action.state)) {
      await client.query(
        `UPDATE commercial_actions
            SET state = 'BLOCKED', failure_code = $2, updated_at = now()
          WHERE id = $1`,
        [actionId, consent.code],
      );
    }
    return { ok: false, code: consent.code, statusCode: 409 };
  }

  const today = await client.query(
    `SELECT COUNT(*)::int AS count
       FROM commercial_actions
      WHERE target_id = $1
        AND id <> $2
        AND approved_at >=
          date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [action.target_id, action.id],
  );
  if (today.rows[0].count >= policy.daily_activation_limit) {
    if (mutateBlock) {
      await client.query(
        `UPDATE commercial_actions
            SET state = 'BLOCKED',
                failure_code = 'DAILY_ACTIVATION_LIMIT',
                updated_at = now()
          WHERE id = $1`,
        [actionId],
      );
    }
    return { ok: false, code: "DAILY_ACTIVATION_LIMIT", statusCode: 409 };
  }

  const recent = await client.query(
    `SELECT id, approved_at
       FROM commercial_actions
      WHERE contact_id = $1
        AND id <> $2
        AND approved_at IS NOT NULL
        AND approved_at > now() - ($3 * interval '1 hour')
      ORDER BY approved_at DESC
      LIMIT 1`,
    [action.contact_id, action.id, policy.cooldown_hours],
  );
  if (recent.rowCount > 0) {
    if (mutateBlock) {
      await client.query(
        `UPDATE commercial_actions
            SET state = 'BLOCKED',
                failure_code = 'CONTACT_COOLDOWN',
                updated_at = now()
          WHERE id = $1`,
        [actionId],
      );
    }
    return { ok: false, code: "CONTACT_COOLDOWN", statusCode: 409 };
  }

  return {
    ok: true,
    action,
    contact,
    report,
    policy,
  };
}

export async function checkCommercialActionEligibility(actionId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await lockedEligibility(client, actionId);
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markCommercialActionPending({
  actionId,
  approvalId,
}) {
  const result = await pool.query(
    `UPDATE commercial_actions
        SET state = 'PENDING_APPROVAL',
            approval_id = $2,
            updated_at = now()
      WHERE id = $1
        AND state = 'DRAFT'
      RETURNING *`,
    [actionId, approvalId],
  );
  return mapAction(result.rows[0]);
}

export async function activateCommercialAction({
  actionId,
  approvalId,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT * FROM commercial_actions WHERE id = $1",
      [actionId],
    );
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return { ok: false, code: "ACTION_NOT_FOUND", statusCode: 404 };
    }
    if (["APPROVED", "SENT"].includes(current.rows[0].state)) {
      await client.query("COMMIT");
      return { ok: true, action: mapAction(current.rows[0]), idempotent: true };
    }

    const eligibility = await lockedEligibility(client, actionId, {
      mutateBlock: true,
    });
    if (!eligibility.ok) {
      await audit(client, current.rows[0].target_id, "OUTBOUND_ACTIVATION_BLOCKED", {
        actionId,
        code: eligibility.code,
      });
      await client.query("COMMIT");
      return eligibility;
    }

    const activated = await client.query(
      `UPDATE commercial_actions
          SET state = 'APPROVED',
              approval_id = $2,
              approved_at = COALESCE(approved_at, now()),
              failure_code = NULL,
              updated_at = now()
        WHERE id = $1
          AND state IN ('DRAFT','PENDING_APPROVAL')
        RETURNING *`,
      [actionId, approvalId],
    );
    if (activated.rowCount === 0) {
      throw problem("ACTION_NOT_ACTIVATABLE", "commercial action is not activatable");
    }

    await audit(client, eligibility.action.target_id, "OUTBOUND_ACTION_APPROVED", {
      actionId,
      approvalId,
      opportunityId: eligibility.action.opportunity_id,
      contactId: eligibility.action.contact_id,
    });
    await client.query("COMMIT");
    return { ok: true, action: mapAction(activated.rows[0]), idempotent: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectCommercialAction({
  actionId,
  approvalId,
}) {
  const result = await pool.query(
    `UPDATE commercial_actions
        SET state = 'CANCELLED',
            approval_id = COALESCE(approval_id, $2),
            failure_code = 'HUMAN_REJECTED',
            updated_at = now()
      WHERE id = $1
        AND state IN ('DRAFT','PENDING_APPROVAL')
      RETURNING *`,
    [actionId, approvalId],
  );
  return mapAction(result.rows[0]) || await getCommercialAction(actionId);
}

export async function recordCommercialDelivery({
  actionId,
  state,
  deliveredBy,
  providerReference = null,
  failureCode = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lookup = await client.query(
      "SELECT id, contact_id FROM commercial_actions WHERE id = $1",
      [actionId],
    );
    if (lookup.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const contactResult = await client.query(
      "SELECT * FROM commercial_contacts WHERE id = $1 FOR UPDATE",
      [lookup.rows[0].contact_id],
    );
    const current = await client.query(
      "SELECT * FROM commercial_actions WHERE id = $1 FOR UPDATE",
      [actionId],
    );
    const action = current.rows[0];
    if (!action) {
      await client.query("ROLLBACK");
      return null;
    }
    if (action.state === state) {
      const immutableMismatch =
        action.delivered_by !== deliveredBy ||
        (providerReference != null &&
          action.provider_reference !== providerReference) ||
        (state === "FAILED" &&
          failureCode != null &&
          action.failure_code !== failureCode);
      if (immutableMismatch) {
        throw problem(
          "IDEMPOTENCY_CONFLICT",
          "delivery state already exists with different immutable values",
        );
      }
      await client.query("COMMIT");
      return mapAction(action);
    }
    if (action.state !== "APPROVED") {
      throw problem(
        "ACTION_NOT_APPROVED",
        "commercial action is not approved for delivery recording",
      );
    }

    if (state === "SENT") {
      const consent = contactCanActivate(contactResult.rows[0]);
      if (!consent.ok) {
        await client.query(
          `UPDATE commercial_actions
              SET state = 'BLOCKED',
                  failure_code = $2,
                  updated_at = now()
            WHERE id = $1`,
          [actionId, consent.code],
        );
        await client.query("COMMIT");
        return { blocked: true, code: consent.code };
      }
    }

    const result = await client.query(
      `UPDATE commercial_actions
          SET state = $2,
              sent_at = CASE WHEN $2 = 'SENT' THEN now() ELSE sent_at END,
              delivered_by = $3,
              provider_reference = $4,
              failure_code = CASE WHEN $2 = 'FAILED' THEN $5 ELSE NULL END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [actionId, state, deliveredBy, providerReference, failureCode],
    );

    if (state === "SENT" && action.kind === "PROPOSAL_SHARE") {
      await client.query(
        `UPDATE commercial_opportunities
            SET state = CASE
                  WHEN state IN ('NEW','QUALIFIED','ENGAGED') THEN 'PROPOSAL'
                  ELSE state
                END,
                updated_at = now()
          WHERE id = $1`,
        [action.opportunity_id],
      );
    }

    await audit(client, action.target_id, "OUTBOUND_DELIVERY_RECORDED", {
      actionId,
      state,
      opportunityId: action.opportunity_id,
      contactId: action.contact_id,
    });
    await client.query("COMMIT");
    return mapAction(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordCommercialResponse({
  actionId,
  responseType,
  summary = null,
  occurredAt = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const lookup = await client.query(
      "SELECT id, contact_id FROM commercial_actions WHERE id = $1",
      [actionId],
    );
    if (lookup.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      "SELECT id FROM commercial_contacts WHERE id = $1 FOR UPDATE",
      [lookup.rows[0].contact_id],
    );
    const actionResult = await client.query(
      "SELECT * FROM commercial_actions WHERE id = $1 FOR UPDATE",
      [actionId],
    );
    if (actionResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const action = actionResult.rows[0];
    if (action.state !== "SENT") {
      throw problem("ACTION_NOT_SENT", "response can only be recorded for a sent action");
    }

    const response = await client.query(
      `INSERT INTO commercial_responses (
         action_id, opportunity_id, contact_id, response_type,
         summary, occurred_at
       )
       VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now()))
       RETURNING *`,
      [
        action.id,
        action.opportunity_id,
        action.contact_id,
        responseType,
        summary,
        occurredAt,
      ],
    );

    if (responseType === "OPTED_OUT") {
      await client.query(
        `UPDATE commercial_contacts
            SET consent_state = 'OPTED_OUT',
                consent_source = 'response',
                consent_evidence = $2,
                consent_recorded_at = now(),
                suppressed_at = now(),
                suppression_reason = 'recipient opted out',
                updated_at = now()
          WHERE id = $1`,
        [action.contact_id, `response:${response.rows[0].id}`],
      );
      const blocked = await client.query(
        `UPDATE commercial_actions
            SET state = 'BLOCKED',
                failure_code = 'CONTACT_OPTED_OUT',
                updated_at = now()
          WHERE contact_id = $1
            AND id <> $2
            AND state IN ('DRAFT','PENDING_APPROVAL','APPROVED')
          RETURNING id`,
        [action.contact_id, action.id],
      );
      if (blocked.rows.length > 0) {
        await client.query(
          `UPDATE approval_requests
              SET status = 'EXPIRED',
                  decided_at = now(),
                  decision_note = COALESCE(
                    decision_note,
                    'Recipient opted out before activation.'
                  )
            WHERE commercial_action_id = ANY($1::uuid[])
              AND status = 'PENDING'`,
          [blocked.rows.map((item) => item.id)],
        );
      }
    } else if (["REPLIED", "INTERESTED"].includes(responseType)) {
      await client.query(
        `UPDATE commercial_opportunities
            SET state = CASE
                  WHEN state IN ('NEW','QUALIFIED') THEN 'ENGAGED'
                  ELSE state
                END,
                updated_at = now()
          WHERE id = $1`,
        [action.opportunity_id],
      );
    } else if (responseType === "DECLINED") {
      await client.query(
        `UPDATE commercial_opportunities
            SET state = CASE WHEN state <> 'WON' THEN 'LOST' ELSE state END,
                updated_at = now()
          WHERE id = $1`,
        [action.opportunity_id],
      );
    }

    await audit(client, action.target_id, "COMMERCIAL_RESPONSE_RECORDED", {
      actionId,
      opportunityId: action.opportunity_id,
      contactId: action.contact_id,
      responseType,
    });
    await client.query("COMMIT");
    return response.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordRevenueEvent({
  opportunityId,
  kind,
  amountMinor,
  currency,
  externalReference = null,
  occurredAt = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const opportunity = await client.query(
      "SELECT * FROM commercial_opportunities WHERE id = $1 FOR UPDATE",
      [opportunityId],
    );
    if (opportunity.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = opportunity.rows[0];
    if (row.currency && row.currency !== currency) {
      throw problem(
        "CURRENCY_MISMATCH",
        "revenue currency must match the commercial opportunity currency",
      );
    }
    if (!row.currency) {
      await client.query(
        `UPDATE commercial_opportunities
            SET currency = $2, updated_at = now()
          WHERE id = $1`,
        [opportunityId, currency],
      );
    }

    let inserted = await client.query(
      `INSERT INTO revenue_events (
         target_id, opportunity_id, kind, amount_minor,
         currency, external_reference, occurred_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()))
       ON CONFLICT (opportunity_id, kind, external_reference)
         WHERE external_reference IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [
        row.target_id,
        opportunityId,
        kind,
        amountMinor,
        currency,
        externalReference,
        occurredAt,
      ],
    );

    let idempotent = false;
    if (inserted.rowCount === 0 && externalReference) {
      inserted = await client.query(
        `SELECT * FROM revenue_events
          WHERE opportunity_id = $1
            AND kind = $2
            AND external_reference = $3`,
        [opportunityId, kind, externalReference],
      );
      if (inserted.rowCount > 0) {
        const existing = inserted.rows[0];
        if (
          Number(existing.amount_minor) !== amountMinor ||
          existing.currency !== currency
        ) {
          throw problem(
            "IDEMPOTENCY_CONFLICT",
            "revenue reference already exists with different immutable values",
          );
        }
      }
      idempotent = true;
    }

    if (kind === "RECEIVED" && inserted.rowCount > 0) {
      await client.query(
        `UPDATE commercial_opportunities
            SET state = 'WON',
                updated_at = now()
          WHERE id = $1`,
        [opportunityId],
      );
    }

    await audit(client, row.target_id, "REVENUE_EVENT_RECORDED", {
      opportunityId,
      revenueEventId: inserted.rows[0]?.id || null,
      kind,
      currency,
      amountMinor,
      idempotent,
    });
    if (kind === "RECEIVED" && inserted.rows[0] && !idempotent) {
      await enqueueTargetIntegrationEvent({
        client,
        targetId: row.target_id,
        eventType: "revenue.received",
        payload: {
          opportunityId,
          revenueEventId: inserted.rows[0].id,
          currency,
          amountMinor,
        },
        idempotencyKey: `revenue.received:${inserted.rows[0].id}`,
      });
    }
    await client.query("COMMIT");
    return inserted.rows[0]
      ? { ...inserted.rows[0], idempotent }
      : null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createServiceAgreement({
  opportunityId,
  name,
  amountMinor = null,
  currency = null,
  renewalAt = null,
  cadenceDays = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const opportunity = await client.query(
      "SELECT * FROM commercial_opportunities WHERE id = $1 FOR UPDATE",
      [opportunityId],
    );
    if (opportunity.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = opportunity.rows[0];
    if (currency && row.currency && currency !== row.currency) {
      throw problem(
        "CURRENCY_MISMATCH",
        "service currency must match the commercial opportunity currency",
      );
    }

    const received = await client.query(
      `SELECT COALESCE(SUM(
          CASE
            WHEN kind = 'RECEIVED' THEN amount_minor
            WHEN kind = 'REFUNDED' THEN -amount_minor
            ELSE 0
          END
        ),0)::bigint AS net_received
       FROM revenue_events
      WHERE opportunity_id = $1`,
      [opportunityId],
    );
    if (row.state !== "WON" || Number(received.rows[0].net_received) <= 0) {
      throw problem(
        "REVENUE_REQUIRED",
        "active service requires confirmed received revenue",
      );
    }

    const result = await client.query(
      `INSERT INTO service_agreements (
         target_id, opportunity_id, name, amount_minor,
         currency, renewal_at, cadence_days
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        row.target_id,
        opportunityId,
        name,
        amountMinor,
        currency,
        renewalAt,
        cadenceDays,
      ],
    );
    await audit(client, row.target_id, "SERVICE_AGREEMENT_CREATED", {
      opportunityId,
      serviceAgreementId: result.rows[0].id,
    });
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileExpiredCommercialApprovals(limit = 100) {
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const candidates = await client.query(
      `SELECT a.id, a.target_id, a.approval_id
         FROM commercial_actions a
         JOIN approval_requests ar ON ar.id = a.approval_id
        WHERE a.state = 'PENDING_APPROVAL'
          AND ar.action_type = 'OUTBOUND_CONTACT'
          AND ar.status = 'EXPIRED'
        ORDER BY ar.decided_at NULLS LAST, ar.expires_at
        FOR UPDATE OF a SKIP LOCKED
        LIMIT $1`,
      [safeLimit],
    );

    for (const row of candidates.rows) {
      await client.query(
        `UPDATE commercial_actions
            SET state = 'DRAFT',
                approval_id = NULL,
                failure_code = 'APPROVAL_EXPIRED',
                updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
      await audit(client, row.target_id, "OUTBOUND_APPROVAL_RECONCILED", {
        actionId: row.id,
        approvalId: row.approval_id,
      });
    }

    await client.query("COMMIT");
    return candidates.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateServiceAgreement({
  serviceId,
  status,
  renewalAt = undefined,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT * FROM service_agreements WHERE id = $1 FOR UPDATE",
      [serviceId],
    );
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = current.rows[0];
    if (
      ["CANCELLED", "ENDED"].includes(row.status) &&
      status !== row.status
    ) {
      throw problem(
        "SERVICE_STATE_TERMINAL",
        "cancelled or ended service agreements cannot be reactivated",
      );
    }
    const result = await client.query(
      `UPDATE service_agreements
          SET status = $2,
              renewal_at = CASE
                WHEN $3::boolean THEN $4::timestamptz
                ELSE renewal_at
              END,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [serviceId, status, renewalAt !== undefined, renewalAt ?? null],
    );
    await audit(client, row.target_id, "SERVICE_AGREEMENT_UPDATED", {
      serviceAgreementId: serviceId,
      opportunityId: row.opportunity_id,
      from: row.status,
      to: status,
    });
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getRevenueMetrics() {
  const [pipeline, revenue, services, followups, actions] = await Promise.all([
    pool.query(
      `SELECT state, COUNT(*)::int AS count
         FROM commercial_opportunities
        GROUP BY state`,
    ),
    pool.query(
      `SELECT currency,
              COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'CONTRACTED'),0)::bigint AS contracted,
              COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'INVOICED'),0)::bigint AS invoiced,
              COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'RECEIVED'),0)::bigint AS received,
              COALESCE(SUM(amount_minor) FILTER (WHERE kind = 'REFUNDED'),0)::bigint AS refunded
         FROM revenue_events
        GROUP BY currency`,
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
         COUNT(*) FILTER (
           WHERE status = 'ACTIVE'
             AND renewal_at IS NOT NULL
             AND renewal_at <= now() + interval '7 days'
         )::int AS renewals_due_7d
         FROM service_agreements`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM commercial_opportunities
        WHERE state NOT IN ('WON','LOST')
          AND next_action_at IS NOT NULL
          AND next_action_at <= now()`,
    ),
    pool.query(
      `SELECT state, COUNT(*)::int AS count
         FROM commercial_actions
        GROUP BY state`,
    ),
  ]);

  const revenueByCurrency = {};
  for (const row of revenue.rows) {
    revenueByCurrency[row.currency] = {
      contractedMinor: Number(row.contracted),
      invoicedMinor: Number(row.invoiced),
      receivedMinor: Number(row.received),
      refundedMinor: Number(row.refunded),
      netReceivedMinor: Number(row.received) - Number(row.refunded),
    };
  }

  return {
    pipeline: Object.fromEntries(pipeline.rows.map((row) => [row.state, row.count])),
    revenueByCurrency,
    services: {
      active: services.rows[0].active,
      renewalsDue7d: services.rows[0].renewals_due_7d,
    },
    followupsDue: followups.rows[0].count,
    actions: Object.fromEntries(actions.rows.map((row) => [row.state, row.count])),
  };
}

export async function getCommercialMaintenance(limit = 100) {
  const safeLimit = Math.min(Math.max(Math.trunc(Number(limit) || 100), 1), 500);
  const reconciledExpiredApprovals =
    await reconcileExpiredCommercialApprovals(safeLimit);
  const [opportunities, renewals, approvedActions] = await Promise.all([
    pool.query(
      `SELECT id, target_id, state, next_action_at
         FROM commercial_opportunities
        WHERE state NOT IN ('WON','LOST')
          AND next_action_at IS NOT NULL
          AND next_action_at <= now()
        ORDER BY next_action_at
        LIMIT $1`,
      [safeLimit],
    ),
    pool.query(
      `SELECT id, target_id, opportunity_id, renewal_at
         FROM service_agreements
        WHERE status = 'ACTIVE'
          AND renewal_at IS NOT NULL
          AND renewal_at <= now() + interval '7 days'
        ORDER BY renewal_at
        LIMIT $1`,
      [safeLimit],
    ),
    pool.query(
      `SELECT id, target_id, opportunity_id, contact_id, kind, approved_at
         FROM commercial_actions
        WHERE state = 'APPROVED'
        ORDER BY approved_at
        LIMIT $1`,
      [safeLimit],
    ),
  ]);

  return {
    reconciledExpiredApprovals,
    dueOpportunities: opportunities.rows,
    dueRenewals: renewals.rows,
    approvedManualActions: approvedActions.rows,
  };
}
