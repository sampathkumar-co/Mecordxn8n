import { pool } from "../repository.js";
import { createPlatformApiKeySecret } from "./auth.js";
import { limitsForPlan } from "./plans.js";

function safeLimit(value, fallback = 100, max = 500) {
  return Math.min(Math.max(Math.trunc(Number(value) || fallback), 1), max);
}

export async function listUserWorkspaces(userId) {
  const result = await pool.query(
    `SELECT w.id, w.name, w.slug, w.plan, w.status, w.retention_days,
            m.role,
            COALESCE(s.plan, w.plan) AS subscription_plan,
            COALESCE(s.status, 'ACTIVE') AS subscription_status
       FROM workspace_memberships m
       JOIN workspaces w ON w.id = m.workspace_id
       LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
      WHERE m.user_id = $1
      ORDER BY w.created_at`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: row.role,
    plan: row.subscription_plan,
    status: row.status,
    subscriptionStatus: row.subscription_status,
    retentionDays: row.retention_days,
  }));
}

export async function createWorkspace({
  ownerUserId,
  name,
  slug,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO workspaces (name, slug, plan, status)
       VALUES ($1,$2,'FREE','ACTIVE')
       RETURNING *`,
      [name, slug],
    );
    const workspace = result.rows[0];
    await client.query(
      `INSERT INTO workspace_memberships (workspace_id, user_id, role)
       VALUES ($1,$2,'OWNER')`,
      [workspace.id, ownerUserId],
    );
    await client.query(
      `INSERT INTO workspace_subscriptions (
         workspace_id, plan, status, seats
       )
       VALUES ($1,'FREE','ACTIVE',1)`,
      [workspace.id],
    );
    await client.query(
      `INSERT INTO workspace_security_events (
         workspace_id, user_id, event_type, severity, metadata
       )
       VALUES ($1,$2,'WORKSPACE_CREATED','INFO','{}'::jsonb)`,
      [workspace.id, ownerUserId],
    );
    await client.query("COMMIT");
    return {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      role: "OWNER",
      plan: "FREE",
      status: workspace.status,
      retentionDays: workspace.retention_days,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      error.statusCode = 409;
      error.code = "WORKSPACE_SLUG_EXISTS";
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getWorkspace(workspaceId) {
  const result = await pool.query(
    `SELECT w.*, COALESCE(s.plan, w.plan) AS subscription_plan,
            COALESCE(s.status, 'ACTIVE') AS subscription_status,
            s.seats, s.current_period_end
       FROM workspaces w
       LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
      WHERE w.id = $1`,
    [workspaceId],
  );
  if (result.rowCount === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    plan: row.subscription_plan,
    subscriptionStatus: row.subscription_status,
    seats: row.seats || 1,
    currentPeriodEnd: row.current_period_end,
    retentionDays: row.retention_days,
  };
}

export async function getWorkspaceOverview(workspaceId) {
  const [workspace, targets, findings, approvals, jobs, regressions, pipeline, services, revenue, security] =
    await Promise.all([
      getWorkspace(workspaceId),
      pool.query(
        "SELECT COUNT(*)::int AS count FROM targets WHERE workspace_id = $1",
        [workspaceId],
      ),
      pool.query(
        `SELECT
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE f.status = 'VERIFIED')::int AS verified,
           COUNT(*) FILTER (WHERE f.severity = 'HIGH' AND f.status <> 'RESOLVED')::int AS high_open
         FROM findings f
         JOIN targets t ON t.id = f.target_id
        WHERE t.workspace_id = $1`,
        [workspaceId],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count
           FROM approval_requests a
           JOIN targets t ON t.id = a.target_id
          WHERE t.workspace_id = $1
            AND a.status = 'PENDING'`,
        [workspaceId],
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE j.state = 'RUNNING')::int AS running,
           COUNT(*) FILTER (WHERE j.state = 'DEAD_LETTER')::int AS dead_letter,
           COUNT(*) FILTER (WHERE j.created_at >= now() - interval '24 hours')::int AS last_24h
         FROM jobs j
         JOIN targets t ON t.id = j.target_id
        WHERE t.workspace_id = $1`,
        [workspaceId],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count
           FROM regressions r
           JOIN monitoring_policies p ON p.id = r.policy_id
           JOIN targets t ON t.id = p.target_id
          WHERE t.workspace_id = $1
            AND r.status = 'OPEN'`,
        [workspaceId],
      ),
      pool.query(
        `SELECT state, COUNT(*)::int AS count
           FROM commercial_opportunities o
           JOIN targets t ON t.id = o.target_id
          WHERE t.workspace_id = $1
          GROUP BY state`,
        [workspaceId],
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE s.status = 'ACTIVE')::int AS active,
           COUNT(*) FILTER (
             WHERE s.status = 'ACTIVE'
               AND s.renewal_at <= now() + interval '7 days'
           )::int AS renewals_due
         FROM service_agreements s
         JOIN targets t ON t.id = s.target_id
        WHERE t.workspace_id = $1`,
        [workspaceId],
      ),
      pool.query(
        `SELECT r.currency,
                COALESCE(SUM(r.amount_minor) FILTER (WHERE r.kind = 'RECEIVED'),0)::bigint AS received,
                COALESCE(SUM(r.amount_minor) FILTER (WHERE r.kind = 'REFUNDED'),0)::bigint AS refunded
           FROM revenue_events r
           JOIN targets t ON t.id = r.target_id
          WHERE t.workspace_id = $1
          GROUP BY r.currency`,
        [workspaceId],
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count
           FROM workspace_security_events
          WHERE workspace_id = $1
            AND severity IN ('WARN','ERROR')
            AND created_at >= now() - interval '24 hours'`,
        [workspaceId],
      ),
    ]);

  const revenueByCurrency = {};
  for (const row of revenue.rows) {
    revenueByCurrency[row.currency] = {
      receivedMinor: Number(row.received),
      refundedMinor: Number(row.refunded),
      netReceivedMinor: Number(row.received) - Number(row.refunded),
    };
  }

  return {
    workspace,
    targets: targets.rows[0].count,
    findings: findings.rows[0],
    pendingApprovals: approvals.rows[0].count,
    jobs: jobs.rows[0],
    openRegressions: regressions.rows[0].count,
    pipeline: Object.fromEntries(
      pipeline.rows.map((row) => [row.state, row.count]),
    ),
    services: services.rows[0],
    revenueByCurrency,
    securityEvents24h: security.rows[0].count,
  };
}

export async function listWorkspaceTargets(workspaceId, limit = 100) {
  const result = await pool.query(
    `SELECT t.id, t.organization_name, t.base_url, t.created_at,
            a.mode AS authorization_mode, a.expires_at AS authorization_expires_at,
            COUNT(DISTINCT f.id)::int AS finding_count,
            COUNT(DISTINCT p.id)::int AS monitor_count
       FROM targets t
       LEFT JOIN authorizations a
         ON a.target_id = t.id AND a.revoked_at IS NULL
       LEFT JOIN findings f ON f.target_id = t.id
       LEFT JOIN monitoring_policies p ON p.target_id = t.id AND p.enabled = true
      WHERE t.workspace_id = $1
      GROUP BY t.id, a.mode, a.expires_at
      ORDER BY t.created_at DESC
      LIMIT $2`,
    [workspaceId, safeLimit(limit)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    organizationName: row.organization_name,
    baseUrl: row.base_url,
    createdAt: row.created_at,
    authorizationMode: row.authorization_mode,
    authorizationExpiresAt: row.authorization_expires_at,
    findingCount: row.finding_count,
    monitorCount: row.monitor_count,
  }));
}

export async function targetBelongsToWorkspace(targetId, workspaceId) {
  const result = await pool.query(
    "SELECT id FROM targets WHERE id = $1 AND workspace_id = $2",
    [targetId, workspaceId],
  );
  return result.rowCount > 0;
}

export async function listWorkspaceFindings({
  workspaceId,
  status = null,
  limit = 100,
}) {
  const result = await pool.query(
    `SELECT f.id, f.target_id, t.organization_name, f.category, f.title,
            f.severity, f.confidence, f.status, f.verification_state,
            f.affected_url, f.occurrences, f.first_seen_at, f.last_seen_at,
            i.opportunity_score, i.impact_tier
       FROM findings f
       JOIN targets t ON t.id = f.target_id
       LEFT JOIN finding_intelligence i ON i.finding_id = f.id
      WHERE t.workspace_id = $1
        AND ($2::text IS NULL OR f.status = $2)
      ORDER BY
        CASE f.severity
          WHEN 'HIGH' THEN 4 WHEN 'MEDIUM' THEN 3 WHEN 'LOW' THEN 2 ELSE 1
        END DESC,
        f.last_seen_at DESC
      LIMIT $3`,
    [workspaceId, status || null, safeLimit(limit)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    targetId: row.target_id,
    organizationName: row.organization_name,
    category: row.category,
    title: row.title,
    severity: row.severity,
    confidence: Number(row.confidence),
    status: row.status,
    verificationState: row.verification_state,
    affectedUrl: row.affected_url,
    occurrences: row.occurrences,
    opportunityScore:
      row.opportunity_score == null ? null : Number(row.opportunity_score),
    impactTier: row.impact_tier,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}

export async function getWorkspaceFinding(workspaceId, findingId) {
  const finding = await pool.query(
    `SELECT f.*, t.organization_name,
            i.business_impact_score, i.buyer_relevance,
            i.repair_feasibility, i.engineering_effort,
            i.opportunity_score, i.impact_tier,
            i.affected_journey, i.rationale
       FROM findings f
       JOIN targets t ON t.id = f.target_id
       LEFT JOIN finding_intelligence i ON i.finding_id = f.id
      WHERE f.id = $1
        AND t.workspace_id = $2`,
    [findingId, workspaceId],
  );
  if (finding.rowCount === 0) return null;
  const [verification, artifacts] = await Promise.all([
    pool.query(
      `SELECT status, attempts, matched_attempts, confidence,
              evidence, created_at
         FROM finding_verifications
        WHERE finding_id = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [findingId],
    ),
    pool.query(
      `SELECT id, kind, path, sha256, byte_length, metadata, created_at
         FROM evidence_artifacts
        WHERE finding_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [findingId],
    ),
  ]);
  return {
    ...finding.rows[0],
    confidence: Number(finding.rows[0].confidence),
    opportunity_score:
      finding.rows[0].opportunity_score == null
        ? null
        : Number(finding.rows[0].opportunity_score),
    verifications: verification.rows,
    artifacts: artifacts.rows,
  };
}

export async function listWorkspaceApprovals({
  workspaceId,
  status = null,
  limit = 100,
}) {
  const result = await pool.query(
    `SELECT a.id, a.target_id, t.organization_name, a.finding_id,
            a.report_id, a.commercial_action_id, a.action_type,
            a.status, a.requested_by, a.decided_by, a.decision_note,
            a.expires_at, a.created_at, a.decided_at
       FROM approval_requests a
       JOIN targets t ON t.id = a.target_id
      WHERE t.workspace_id = $1
        AND ($2::text IS NULL OR a.status = $2)
      ORDER BY
        CASE WHEN a.status = 'PENDING' THEN 0 ELSE 1 END,
        a.created_at DESC
      LIMIT $3`,
    [workspaceId, status || null, safeLimit(limit)],
  );
  return result.rows;
}

export async function approvalBelongsToWorkspace(approvalId, workspaceId) {
  const result = await pool.query(
    `SELECT a.*
       FROM approval_requests a
       JOIN targets t ON t.id = a.target_id
      WHERE a.id = $1
        AND t.workspace_id = $2`,
    [approvalId, workspaceId],
  );
  return result.rows[0] || null;
}

export async function listWorkspacePipeline(workspaceId, limit = 100) {
  const result = await pool.query(
    `SELECT o.id, o.target_id, t.organization_name, o.primary_finding_id,
            o.source_report_id, o.title, o.state,
            o.opportunity_score, o.estimated_value_minor, o.currency,
            o.next_action_at, o.created_at, o.updated_at,
            COUNT(DISTINCT a.id) FILTER (WHERE a.state = 'SENT')::int AS sent_actions,
            COUNT(DISTINCT r.id)::int AS responses
       FROM commercial_opportunities o
       JOIN targets t ON t.id = o.target_id
       LEFT JOIN commercial_actions a ON a.opportunity_id = o.id
       LEFT JOIN commercial_responses r ON r.opportunity_id = o.id
      WHERE t.workspace_id = $1
      GROUP BY o.id, t.organization_name
      ORDER BY o.opportunity_score DESC, o.updated_at DESC
      LIMIT $2`,
    [workspaceId, safeLimit(limit)],
  );
  return result.rows.map((row) => ({
    ...row,
    opportunity_score: Number(row.opportunity_score),
    estimated_value_minor:
      row.estimated_value_minor == null ? null : Number(row.estimated_value_minor),
  }));
}

export async function getWorkspaceOpportunityDetail(workspaceId, opportunityId) {
  const opportunity = await pool.query(
    `SELECT o.*, t.organization_name, t.base_url
       FROM commercial_opportunities o
       JOIN targets t ON t.id = o.target_id
      WHERE o.id = $1
        AND t.workspace_id = $2`,
    [opportunityId, workspaceId],
  );
  if (opportunity.rowCount === 0) return null;
  const row = opportunity.rows[0];

  const [actions, responses, revenue, services, report] = await Promise.all([
    pool.query(
      `SELECT id, kind, channel, state, approval_id, approved_at,
              sent_at, delivered_by, failure_code, created_at, updated_at
         FROM commercial_actions
        WHERE opportunity_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [opportunityId],
    ),
    pool.query(
      `SELECT id, response_type, summary, occurred_at, created_at
         FROM commercial_responses
        WHERE opportunity_id = $1
        ORDER BY occurred_at DESC
        LIMIT 100`,
      [opportunityId],
    ),
    pool.query(
      `SELECT id, kind, amount_minor, currency, external_reference,
              occurred_at, created_at
         FROM revenue_events
        WHERE opportunity_id = $1
        ORDER BY occurred_at DESC
        LIMIT 100`,
      [opportunityId],
    ),
    pool.query(
      `SELECT id, name, status, amount_minor, currency, renewal_at,
              cadence_days, created_at, updated_at
         FROM service_agreements
        WHERE opportunity_id = $1
        ORDER BY created_at DESC
        LIMIT 100`,
      [opportunityId],
    ),
    row.source_report_id
      ? pool.query(
          `SELECT id, kind, status, summary, created_at, updated_at
             FROM reports
            WHERE id = $1 AND target_id = $2`,
          [row.source_report_id, row.target_id],
        )
      : Promise.resolve({ rows: [] }),
  ]);

  return {
    opportunity: {
      ...row,
      opportunity_score: Number(row.opportunity_score),
      estimated_value_minor:
        row.estimated_value_minor == null ? null : Number(row.estimated_value_minor),
    },
    report: report.rows[0] || null,
    actions: actions.rows,
    responses: responses.rows,
    revenueEvents: revenue.rows.map((item) => ({
      ...item,
      amount_minor: Number(item.amount_minor),
    })),
    services: services.rows.map((item) => ({
      ...item,
      amount_minor: item.amount_minor == null ? null : Number(item.amount_minor),
    })),
  };
}

export async function listWorkspaceReports(workspaceId, targetId = null, limit = 100) {
  const result = await pool.query(
    `SELECT r.id, r.target_id, t.organization_name, r.kind, r.status,
            r.summary, r.created_at, r.updated_at
       FROM reports r
       JOIN targets t ON t.id = r.target_id
      WHERE t.workspace_id = $1
        AND ($2::uuid IS NULL OR r.target_id = $2)
      ORDER BY r.created_at DESC
      LIMIT $3`,
    [workspaceId, targetId || null, safeLimit(limit)],
  );
  return result.rows;
}

export async function listWorkspaceOperations(workspaceId, limit = 100) {
  const [jobs, regressions, monitors] = await Promise.all([
    pool.query(
      `SELECT j.id, j.target_id, t.organization_name, j.job_type,
              j.capability, j.state, j.attempt_count, j.max_attempts,
              j.cost_units, j.created_at, j.started_at, j.completed_at,
              j.lease_owner AS worker_id, j.last_heartbeat_at,
              j.next_attempt_at,
              NULLIF(j.input->>'findingId', '') AS finding_id,
              NULLIF(j.input->>'approvalId', '') AS approval_id
         FROM jobs j
         JOIN targets t ON t.id = j.target_id
        WHERE t.workspace_id = $1
        ORDER BY j.created_at DESC
        LIMIT $2`,
      [workspaceId, safeLimit(limit)],
    ),
    pool.query(
      `SELECT r.id, r.policy_id, p.target_id, t.organization_name,
              r.category, r.severity, r.summary, r.status,
              r.created_at, r.resolved_at
         FROM regressions r
         JOIN monitoring_policies p ON p.id = r.policy_id
         JOIN targets t ON t.id = p.target_id
        WHERE t.workspace_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2`,
      [workspaceId, safeLimit(limit)],
    ),
    pool.query(
      `SELECT p.id, p.target_id, t.organization_name, p.name,
              p.capability, p.cadence_minutes, p.enabled,
              p.daily_budget_units, p.next_run_at, p.last_run_at,
              p.consecutive_failures
         FROM monitoring_policies p
         JOIN targets t ON t.id = p.target_id
        WHERE t.workspace_id = $1
        ORDER BY p.created_at DESC
        LIMIT $2`,
      [workspaceId, safeLimit(limit)],
    ),
  ]);
  return {
    jobs: jobs.rows,
    regressions: regressions.rows,
    monitors: monitors.rows,
  };
}

export async function listWorkspaceAudit(workspaceId, limit = 100) {
  const result = await pool.query(
    `SELECT a.id, a.target_id, a.job_id, a.event_type,
            a.payload, a.created_at
       FROM audit_events a
       JOIN targets t ON t.id = a.target_id
      WHERE t.workspace_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [workspaceId, safeLimit(limit, 100, 1000)],
  );
  return result.rows;
}

export async function listWorkspaceMembers(workspaceId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.display_name, u.status,
            m.role, m.created_at
       FROM workspace_memberships m
       JOIN platform_users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY
        CASE m.role
          WHEN 'OWNER' THEN 4 WHEN 'ADMIN' THEN 3
          WHEN 'OPERATOR' THEN 2 ELSE 1
        END DESC,
        lower(u.email)`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    role: row.role,
    createdAt: row.created_at,
  }));
}

export async function updateWorkspaceMemberRole({
  workspaceId,
  userId,
  role,
}) {
  const result = await pool.query(
    `UPDATE workspace_memberships
        SET role = $3
      WHERE workspace_id = $1
        AND user_id = $2
        AND role <> 'OWNER'
      RETURNING workspace_id, user_id, role`,
    [workspaceId, userId, role],
  );
  return result.rows[0] || null;
}

export async function removeWorkspaceMember({
  workspaceId,
  userId,
}) {
  const result = await pool.query(
    `DELETE FROM workspace_memberships
      WHERE workspace_id = $1
        AND user_id = $2
        AND role <> 'OWNER'
      RETURNING user_id`,
    [workspaceId, userId],
  );
  return result.rowCount > 0;
}

export async function createWorkspaceApiKey({
  workspaceId,
  createdBy,
  name,
  scopes,
  rateLimitPerHour = 2000,
  expiresAt = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const plan = await client.query(
      `SELECT COALESCE(s.plan, w.plan) AS plan
         FROM workspaces w
         LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
        WHERE w.id = $1
        FOR UPDATE OF w`,
      [workspaceId],
    );
    if (plan.rowCount === 0) {
      const error = new Error("workspace not found");
      error.statusCode = 404;
      error.code = "WORKSPACE_NOT_FOUND";
      throw error;
    }
    const limit = limitsForPlan(plan.rows[0].plan).apiKeys;
    if (limit != null) {
      const count = await client.query(
        `SELECT COUNT(*)::int AS count
           FROM platform_api_keys
          WHERE workspace_id = $1
            AND revoked_at IS NULL`,
        [workspaceId],
      );
      if (count.rows[0].count >= limit) {
        const error = new Error("workspace API key quota reached");
        error.statusCode = 409;
        error.code = "PLAN_API_KEY_LIMIT";
        throw error;
      }
    }

    const secret = createPlatformApiKeySecret();
    const result = await client.query(
      `INSERT INTO platform_api_keys (
         workspace_id, created_by, name, key_prefix, secret_hash,
         scopes, rate_limit_per_hour, expires_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, workspace_id, name, key_prefix, scopes,
                 rate_limit_per_hour, expires_at, created_at`,
      [
        workspaceId,
        createdBy,
        name,
        secret.prefix,
        secret.secretHash,
        scopes,
        rateLimitPerHour,
        expiresAt,
      ],
    );
    await client.query("COMMIT");
    return {
      apiKey: result.rows[0],
      secret: secret.token,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWorkspaceApiKeys(workspaceId) {
  const result = await pool.query(
    `SELECT id, name, key_prefix, scopes, rate_limit_per_hour,
            expires_at, revoked_at, last_used_at, created_at
       FROM platform_api_keys
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows;
}

export async function revokeWorkspaceApiKey(workspaceId, apiKeyId) {
  const result = await pool.query(
    `UPDATE platform_api_keys
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1
        AND workspace_id = $2
      RETURNING id`,
    [apiKeyId, workspaceId],
  );
  return result.rowCount > 0;
}

export async function getWorkspaceSubscription(workspaceId) {
  const [workspace, subscription, usage, counts] = await Promise.all([
    getWorkspace(workspaceId),
    pool.query(
      "SELECT * FROM workspace_subscriptions WHERE workspace_id = $1",
      [workspaceId],
    ),
    pool.query(
      `SELECT *
         FROM workspace_usage_monthly
        WHERE workspace_id = $1
          AND usage_month =
            date_trunc('month', now() AT TIME ZONE 'UTC')::date`,
      [workspaceId],
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM targets WHERE workspace_id = $1)::int AS targets,
         (SELECT COUNT(*) FROM workspace_memberships WHERE workspace_id = $1)::int AS members,
         (SELECT COUNT(*) FROM platform_api_keys WHERE workspace_id = $1 AND revoked_at IS NULL)::int AS api_keys`,
      [workspaceId],
    ),
  ]);
  if (!workspace) return null;
  const plan = subscription.rows[0]?.plan || workspace.plan;
  return {
    workspace,
    subscription: subscription.rows[0] || null,
    usage: usage.rows[0] || {
      jobs_created: 0,
      targets_created: 0,
    },
    counts: counts.rows[0],
    limits: limitsForPlan(plan),
  };
}

export async function updateWorkspaceRetention(workspaceId, retentionDays) {
  const result = await pool.query(
    `UPDATE workspaces
        SET retention_days = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING id, retention_days`,
    [workspaceId, retentionDays],
  );
  return result.rows[0] || null;
}

export async function purgeExpiredWorkspaceData() {
  const result = await pool.query(
    `WITH deleted AS (
       DELETE FROM audit_events a
       USING targets t, workspaces w
       WHERE a.target_id = t.id
         AND t.workspace_id = w.id
         AND a.created_at < now() - (w.retention_days * interval '1 day')
       RETURNING a.id
     )
     SELECT COUNT(*)::int AS count FROM deleted`,
  );
  await pool.query(
    `DELETE FROM platform_sessions
      WHERE revoked_at IS NOT NULL
         OR expires_at < now() - interval '7 days'`,
  );
  await pool.query(
    `DELETE FROM platform_rate_buckets
      WHERE bucket_start < now() - interval '48 hours'`,
  );
  return result.rows[0].count;
}

export async function deleteWorkspace({
  workspaceId,
  ownerUserId,
  confirmationSlug,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workspace = await client.query(
      `SELECT w.*
         FROM workspaces w
         JOIN workspace_memberships m
           ON m.workspace_id = w.id
          AND m.user_id = $2
          AND m.role = 'OWNER'
        WHERE w.id = $1
        FOR UPDATE OF w`,
      [workspaceId, ownerUserId],
    );
    if (workspace.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    if (workspace.rows[0].slug !== confirmationSlug) {
      const error = new Error("workspace deletion confirmation does not match slug");
      error.statusCode = 400;
      error.code = "DELETION_CONFIRMATION_MISMATCH";
      throw error;
    }
    if (workspaceId === "00000000-0000-4000-8000-000000000001") {
      const error = new Error("system workspace cannot be deleted");
      error.statusCode = 403;
      error.code = "SYSTEM_WORKSPACE_PROTECTED";
      throw error;
    }
    await client.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
