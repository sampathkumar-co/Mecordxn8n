import { createHash, randomBytes } from "node:crypto";

import { pool } from "../repository.js";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function randomToken(prefix, bytes = 32) {
  return prefix + randomBytes(bytes).toString("base64url");
}

function mapOnboarding(row) {
  return row
    ? {
        workspaceId: row.workspace_id,
        status: row.status,
        completedSteps: row.completed_steps || [],
        finalizationAttempts: Number(row.finalization_attempts || 0),
        lastErrorCode: row.last_error_code || null,
        primaryTargetId: row.primary_target_id,
        firstHttpJobId: row.first_http_job_id,
        firstBrowserJobId: row.first_browser_job_id,
        firstReportId: row.first_report_id,
        blockedReason: row.blocked_reason,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        updatedAt: row.updated_at,
      }
    : null;
}

export async function consumePublicRateLimit({
  key,
  limit,
}) {
  const keyHash = sha256(key);
  const result = await pool.query(
    `INSERT INTO platform_public_rate_buckets (
       key_hash, bucket_start, request_count
     )
     VALUES (
       $1,
       date_trunc('hour', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC',
       1
     )
     ON CONFLICT (key_hash, bucket_start)
     DO UPDATE SET request_count = platform_public_rate_buckets.request_count + 1
     RETURNING request_count`,
    [keyHash],
  );
  return Number(result.rows[0].request_count) <= Number(limit);
}

export async function purgePublicRateLimits() {
  const result = await pool.query(
    `DELETE FROM platform_public_rate_buckets
      WHERE bucket_start < now() - interval '48 hours'`,
  );
  return result.rowCount;
}

export async function getWorkspaceOnboarding(workspaceId) {
  await pool.query(
    `INSERT INTO workspace_onboarding (workspace_id)
     VALUES ($1)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId],
  );
  const result = await pool.query(
    `SELECT o.*,
            EXISTS(
              SELECT 1 FROM targets t WHERE t.workspace_id = o.workspace_id
            ) AS has_target,
            EXISTS(
              SELECT 1
                FROM domain_verifications d
               WHERE d.workspace_id = o.workspace_id
                 AND d.status = 'VERIFIED'
            ) AS has_verified_domain,
            EXISTS(
              SELECT 1
                FROM workspace_subscriptions s
               WHERE s.workspace_id = o.workspace_id
                 AND s.status IN ('TRIALING','ACTIVE')
            ) AS has_subscription,
            EXISTS(
              SELECT 1
                FROM reports r
                JOIN targets t ON t.id = r.target_id
               WHERE t.workspace_id = o.workspace_id
            ) AS has_report
       FROM workspace_onboarding o
      WHERE o.workspace_id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const onboarding = mapOnboarding(row);
  return {
    ...onboarding,
    checklist: {
      accountCreated: onboarding.completedSteps.includes("ACCOUNT_CREATED"),
      targetRegistered: row.has_target,
      ownershipVerified: row.has_verified_domain,
      subscriptionReady: row.has_subscription,
      assessmentStarted: Boolean(row.first_http_job_id || row.first_browser_job_id),
      reportReady: Boolean(row.first_report_id || row.has_report),
    },
  };
}

export async function markOnboardingStep({
  workspaceId,
  step,
  primaryTargetId = undefined,
  firstHttpJobId = undefined,
  firstBrowserJobId = undefined,
  firstReportId = undefined,
  status = undefined,
  blockedReason = undefined,
}) {
  const result = await pool.query(
    `INSERT INTO workspace_onboarding (
       workspace_id, completed_steps, primary_target_id,
       first_http_job_id, first_browser_job_id, first_report_id,
       status, blocked_reason, completed_at
     )
     VALUES (
       $1, ARRAY[$2]::text[], $3, $4, $5, $6,
       COALESCE($7,'IN_PROGRESS'), $8,
       CASE WHEN $7 = 'READY' THEN now() ELSE NULL END
     )
     ON CONFLICT (workspace_id)
     DO UPDATE SET
       completed_steps = (
         SELECT ARRAY(
           SELECT DISTINCT x
             FROM unnest(
               workspace_onboarding.completed_steps || ARRAY[$2]::text[]
             ) AS x
         )
       ),
       primary_target_id = COALESCE($3, workspace_onboarding.primary_target_id),
       first_http_job_id = COALESCE($4, workspace_onboarding.first_http_job_id),
       first_browser_job_id = COALESCE($5, workspace_onboarding.first_browser_job_id),
       first_report_id = COALESCE($6, workspace_onboarding.first_report_id),
       status = COALESCE($7, workspace_onboarding.status),
       blocked_reason = CASE
         WHEN $8::text IS NOT NULL THEN $8
         WHEN $7 = 'READY' THEN NULL
         ELSE workspace_onboarding.blocked_reason
       END,
       completed_at = CASE
         WHEN $7 = 'READY' THEN COALESCE(workspace_onboarding.completed_at, now())
         ELSE workspace_onboarding.completed_at
       END,
       updated_at = now()
     RETURNING *`,
    [
      workspaceId,
      step,
      primaryTargetId ?? null,
      firstHttpJobId ?? null,
      firstBrowserJobId ?? null,
      firstReportId ?? null,
      status ?? null,
      blockedReason ?? null,
    ],
  );
  return mapOnboarding(result.rows[0]);
}

export async function createDomainVerification({
  workspaceId,
  targetId,
  hostname,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query(
      `SELECT id FROM targets
        WHERE id = $1 AND workspace_id = $2
        FOR UPDATE`,
      [targetId, workspaceId],
    );
    if (target.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE domain_verifications
          SET status = CASE
                WHEN expires_at <= now() THEN 'EXPIRED'
                ELSE 'REVOKED'
              END,
              updated_at = now()
        WHERE target_id = $1
          AND status = 'PENDING'`,
      [targetId],
    );
    const challenge =
      "mecordxn8n-verification=" + randomBytes(24).toString("base64url");
    const result = await client.query(
      `INSERT INTO domain_verifications (
         workspace_id, target_id, hostname, method,
         challenge, expires_at
       )
       VALUES ($1,$2,$3,'DNS_TXT',$4,now() + interval '30 minutes')
       RETURNING *`,
      [workspaceId, targetId, hostname, challenge],
    );
    await client.query(
      `INSERT INTO workspace_security_events (
         workspace_id, event_type, severity, metadata
       )
       VALUES (
         $1,'DOMAIN_VERIFICATION_CREATED','INFO',
         jsonb_build_object('targetId',$2::text,'hostname',$3::text)
       )`,
      [workspaceId, targetId, hostname],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getDomainVerification({
  workspaceId,
  verificationId,
}) {
  const result = await pool.query(
    `SELECT * FROM domain_verifications
      WHERE id = $1 AND workspace_id = $2`,
    [verificationId, workspaceId],
  );
  return result.rows[0] || null;
}

export async function completeDomainVerification({
  workspaceId,
  verificationId,
  matched,
  errorCode = null,
}) {
  const result = await pool.query(
    `UPDATE domain_verifications
        SET attempts = attempts + 1,
            status = CASE
              WHEN $3::boolean THEN 'VERIFIED'
              WHEN expires_at <= now() THEN 'EXPIRED'
              ELSE status
            END,
            verified_at = CASE WHEN $3::boolean THEN now() ELSE verified_at END,
            last_error_code = CASE WHEN $3::boolean THEN NULL ELSE $4 END,
            updated_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND status = 'PENDING'
      RETURNING *`,
    [verificationId, workspaceId, Boolean(matched), errorCode],
  );
  if (!result.rows[0]) {
    return await getDomainVerification({ workspaceId, verificationId });
  }
  if (matched) {
    await markOnboardingStep({
      workspaceId,
      step: "OWNERSHIP_VERIFIED",
      primaryTargetId: result.rows[0].target_id,
    });
  }
  return result.rows[0];
}

export async function hasVerifiedDomain({
  workspaceId,
  targetId,
}) {
  const result = await pool.query(
    `SELECT EXISTS(
       SELECT 1 FROM domain_verifications
        WHERE workspace_id = $1
          AND target_id = $2
          AND status = 'VERIFIED'
     ) AS ok`,
    [workspaceId, targetId],
  );
  return Boolean(result.rows[0]?.ok);
}

export async function listTargetAuthorizationCenter({
  workspaceId,
  targetId,
}) {
  const target = await pool.query(
    `SELECT t.id, t.organization_name, t.base_url, t.created_at
       FROM targets t
      WHERE t.id = $1 AND t.workspace_id = $2`,
    [targetId, workspaceId],
  );
  if (target.rowCount === 0) return null;
  const [authorizations, verifications] = await Promise.all([
    pool.query(
      `SELECT id, mode, allowed_hosts, allowed_capabilities,
              scope_notes, evidence_reference, expires_at,
              created_at, revoked_at
         FROM authorizations
        WHERE target_id = $1
        ORDER BY created_at DESC`,
      [targetId],
    ),
    pool.query(
      `SELECT id, hostname, method, status, attempts,
              last_error_code, expires_at, verified_at, created_at
         FROM domain_verifications
        WHERE target_id = $1 AND workspace_id = $2
        ORDER BY created_at DESC`,
      [targetId, workspaceId],
    ),
  ]);
  return {
    target: target.rows[0],
    currentAuthorization:
      authorizations.rows.find((row) => !row.revoked_at) || null,
    authorizationHistory: authorizations.rows,
    domainVerifications: verifications.rows,
  };
}

export async function replaceTargetAuthorization({
  workspaceId,
  targetId,
  mode,
  allowedHosts,
  allowedCapabilities,
  scopeNotes = null,
  evidenceReference = null,
  expiresAt = null,
  actorUserId = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query(
      `SELECT id FROM targets
        WHERE id = $1 AND workspace_id = $2
        FOR UPDATE`,
      [targetId, workspaceId],
    );
    if (target.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE authorizations
          SET revoked_at = now()
        WHERE target_id = $1
          AND revoked_at IS NULL`,
      [targetId],
    );
    const result = await client.query(
      `INSERT INTO authorizations (
         target_id, mode, allowed_hosts, allowed_capabilities,
         scope_notes, evidence_reference, expires_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        targetId,
        mode,
        allowedHosts,
        allowedCapabilities,
        scopeNotes,
        evidenceReference,
        expiresAt,
      ],
    );
    await client.query(
      `INSERT INTO workspace_security_events (
         workspace_id, user_id, event_type, severity, metadata
       )
       VALUES (
         $1,$2,'TARGET_AUTHORIZATION_REPLACED','WARN',
         jsonb_build_object(
           'targetId',$3::text,'authorizationId',$4::text,'mode',$5::text
         )
       )`,
      [workspaceId, actorUserId, targetId, result.rows[0].id, mode],
    );
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeTargetAuthorization({
  workspaceId,
  targetId,
  actorUserId = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query(
      `SELECT id FROM targets
        WHERE id = $1 AND workspace_id = $2
        FOR UPDATE`,
      [targetId, workspaceId],
    );
    if (target.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const result = await client.query(
      `UPDATE authorizations
          SET revoked_at = now()
        WHERE target_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [targetId],
    );
    await client.query(
      `UPDATE jobs
          SET state = 'CANCELLED',
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = COALESCE(completed_at, now())
        WHERE target_id = $1
          AND state IN ('QUEUED','RUNNING')`,
      [targetId],
    );
    await client.query(
      `INSERT INTO workspace_security_events (
         workspace_id, user_id, event_type, severity, metadata
       )
       VALUES (
         $1,$2,'TARGET_AUTHORIZATION_REVOKED','WARN',
         jsonb_build_object('targetId',$3::text,'revokedCount',$4::int)
       )`,
      [workspaceId, actorUserId, targetId, result.rowCount],
    );
    await client.query("COMMIT");
    return result.rowCount > 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function setOnboardingAssessmentJobs({
  workspaceId,
  targetId,
  httpJobId = null,
  browserJobId = null,
}) {
  return markOnboardingStep({
    workspaceId,
    step: "ASSESSMENT_STARTED",
    primaryTargetId: targetId,
    firstHttpJobId: httpJobId,
    firstBrowserJobId: browserJobId,
  });
}

export async function claimOnboardingReadyForReport(limit = 25) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH candidates AS (
         SELECT o.workspace_id
           FROM workspace_onboarding o
          WHERE o.status = 'IN_PROGRESS'
            AND o.primary_target_id IS NOT NULL
            AND o.first_report_id IS NULL
            AND (o.first_http_job_id IS NOT NULL OR o.first_browser_job_id IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1
                FROM jobs j
               WHERE j.id IN (o.first_http_job_id, o.first_browser_job_id)
                 AND j.state IN ('QUEUED','RUNNING')
            )
          ORDER BY o.updated_at
          FOR UPDATE OF o SKIP LOCKED
          LIMIT $1
       )
       UPDATE workspace_onboarding o
          SET status = 'FINALIZING',
              finalization_attempts = finalization_attempts + 1,
              last_error_code = NULL,
              updated_at = now()
         FROM candidates
        WHERE o.workspace_id = candidates.workspace_id
       RETURNING o.workspace_id, o.primary_target_id,
                 o.first_http_job_id, o.first_browser_job_id,
                 o.finalization_attempts`,
      [safeLimit],
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failOnboardingFinalization({
  workspaceId,
  errorCode,
}) {
  const result = await pool.query(
    `UPDATE workspace_onboarding
        SET status = CASE
              WHEN finalization_attempts >= 3 THEN 'BLOCKED'
              ELSE 'IN_PROGRESS'
            END,
            blocked_reason = CASE
              WHEN finalization_attempts >= 3 THEN $2
              ELSE NULL
            END,
            last_error_code = $2,
            updated_at = now()
      WHERE workspace_id = $1
        AND status = 'FINALIZING'
      RETURNING *`,
    [workspaceId, String(errorCode || "FINALIZATION_FAILED").slice(0, 120)],
  );
  return mapOnboarding(result.rows[0]);
}

export async function setOnboardingReport({
  workspaceId,
  reportId,
}) {
  return markOnboardingStep({
    workspaceId,
    step: "REPORT_READY",
    firstReportId: reportId,
    status: "READY",
  });
}

export async function reportBelongsToWorkspace({
  workspaceId,
  reportId,
}) {
  const result = await pool.query(
    `SELECT r.id, r.target_id, r.status
       FROM reports r
       JOIN targets t ON t.id = r.target_id
      WHERE r.id = $1
        AND t.workspace_id = $2`,
    [reportId, workspaceId],
  );
  return result.rows[0] || null;
}

export async function createReportShareLink({
  workspaceId,
  reportId,
  createdBy,
  expiresHours = 72,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const report = await client.query(
      `SELECT r.id, r.status
         FROM reports r
         JOIN targets t ON t.id = r.target_id
        WHERE r.id = $1
          AND t.workspace_id = $2
        FOR SHARE`,
      [reportId, workspaceId],
    );
    if (report.rowCount === 0) {
      await client.query("ROLLBACK");
      return { status: "NOT_FOUND" };
    }
    if (report.rows[0].status !== "APPROVED") {
      await client.query("ROLLBACK");
      return { status: "REPORT_NOT_APPROVED" };
    }
    const token = randomToken("mcr_");
    const tokenHash = sha256(token);
    const result = await client.query(
      `INSERT INTO report_share_links (
         workspace_id, report_id, token_hash,
         created_by, expires_at
       )
       VALUES ($1,$2,$3,$4,now() + ($5 * interval '1 hour'))
       RETURNING id, report_id, expires_at, created_at`,
      [workspaceId, reportId, tokenHash, createdBy, expiresHours],
    );
    await client.query("COMMIT");
    return {
      status: "CREATED",
      share: result.rows[0],
      token,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPublicSharedReport(token) {
  const tokenHash = sha256(token);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT s.id AS share_id, s.report_id, s.expires_at,
              r.kind, r.status, r.markdown, r.summary, r.created_at,
              t.organization_name
         FROM report_share_links s
         JOIN reports r ON r.id = s.report_id
         JOIN targets t ON t.id = r.target_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND r.status = 'APPROVED'
        FOR UPDATE OF s`,
      [tokenHash],
    );
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query(
      `UPDATE report_share_links
          SET access_count = access_count + 1,
              last_accessed_at = now()
        WHERE id = $1`,
      [result.rows[0].share_id],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    return {
      reportId: row.report_id,
      kind: row.kind,
      organizationName: row.organization_name,
      markdown: row.markdown,
      summary: row.summary,
      createdAt: row.created_at,
      shareExpiresAt: row.expires_at,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeReportShareLink({
  workspaceId,
  shareId,
}) {
  const result = await pool.query(
    `UPDATE report_share_links
        SET revoked_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND revoked_at IS NULL
      RETURNING id`,
    [shareId, workspaceId],
  );
  return result.rowCount > 0;
}

export async function recordBillingCheckout({
  workspaceId,
  plan,
  providerSessionId,
  providerCustomerId = null,
  checkoutUrl = null,
  expiresAt = null,
  createdBy = null,
}) {
  const result = await pool.query(
    `INSERT INTO billing_checkout_sessions (
       workspace_id, plan, provider_session_id,
       provider_customer_id, checkout_url, expires_at, created_by
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (provider_session_id)
     DO UPDATE SET provider_session_id = EXCLUDED.provider_session_id
     RETURNING *`,
    [
      workspaceId,
      plan,
      providerSessionId,
      providerCustomerId,
      checkoutUrl,
      expiresAt,
      createdBy,
    ],
  );
  return result.rows[0];
}

export async function completeBillingCheckout({
  providerSessionId,
  providerCustomerId = null,
  providerSubscriptionId = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const checkout = await client.query(
      `UPDATE billing_checkout_sessions
          SET status = 'COMPLETE',
              provider_customer_id = COALESCE($2, provider_customer_id),
              completed_at = COALESCE(completed_at, now())
        WHERE provider_session_id = $1
        RETURNING *`,
      [providerSessionId, providerCustomerId],
    );
    if (checkout.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const row = checkout.rows[0];
    await client.query(
      `UPDATE workspace_subscriptions
          SET plan = $2,
              status = 'ACTIVE',
              provider = 'STRIPE',
              external_customer_id = COALESCE($3, external_customer_id),
              external_subscription_id = COALESCE($4, external_subscription_id),
              trial_ends_at = NULL,
              updated_at = now()
        WHERE workspace_id = $1`,
      [
        row.workspace_id,
        row.plan,
        providerCustomerId,
        providerSubscriptionId,
      ],
    );
    await client.query(
      `UPDATE workspaces SET plan = $2, updated_at = now() WHERE id = $1`,
      [row.workspace_id, row.plan],
    );
    await client.query("COMMIT");
    return row;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileBillingInvoice({
  customerId = null,
  subscriptionId = null,
  paid,
}) {
  if (!customerId && !subscriptionId) return null;
  const result = await pool.query(
    `UPDATE workspace_subscriptions
        SET status = CASE WHEN $3::boolean THEN 'ACTIVE' ELSE 'PAST_DUE' END,
            updated_at = now()
      WHERE (
        $1::text IS NOT NULL AND external_customer_id = $1
      ) OR (
        $2::text IS NOT NULL AND external_subscription_id = $2
      )
      RETURNING *`,
    [customerId, subscriptionId, Boolean(paid)],
  );
  return result.rows[0] || null;
}

export async function getWorkspaceLaunchHealth(workspaceId) {
  const [jobs, monitors, integrations, approvals, regressions] = await Promise.all([
    pool.query(
      `SELECT state, COUNT(*)::int AS count
         FROM jobs j
         JOIN targets t ON t.id = j.target_id
        WHERE t.workspace_id = $1
          AND j.created_at >= now() - interval '24 hours'
        GROUP BY state`,
      [workspaceId],
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE enabled)::int AS enabled,
         COUNT(*) FILTER (WHERE enabled AND consecutive_failures > 0)::int AS failing
         FROM monitoring_policies p
         JOIN targets t ON t.id = p.target_id
        WHERE t.workspace_id = $1`,
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
    pool.query(
      `SELECT COUNT(*)::int AS pending
         FROM approval_requests a
         JOIN targets t ON t.id = a.target_id
        WHERE t.workspace_id = $1
          AND a.status = 'PENDING'
          AND a.expires_at > now()`,
      [workspaceId],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS open
         FROM regressions r
         JOIN monitoring_policies p ON p.id = r.policy_id
         JOIN targets t ON t.id = p.target_id
        WHERE t.workspace_id = $1
          AND r.status = 'OPEN'`,
      [workspaceId],
    ),
  ]);
  const jobStates = Object.fromEntries(
    jobs.rows.map((row) => [row.state, row.count]),
  );
  const integrationStates = Object.fromEntries(
    integrations.rows.map((row) => [row.state, row.count]),
  );
  const issues = [];
  if ((jobStates.FAILED || 0) > 0 || (jobStates.DEAD_LETTER || 0) > 0) {
    issues.push("FAILED_JOBS");
  }
  if ((monitors.rows[0]?.failing || 0) > 0) issues.push("FAILING_MONITORS");
  if ((integrationStates.DEAD_LETTER || 0) > 0) issues.push("INTEGRATION_DEAD_LETTERS");
  if ((regressions.rows[0]?.open || 0) > 0) issues.push("OPEN_REGRESSIONS");
  return {
    status: issues.length ? "ATTENTION" : "HEALTHY",
    issues,
    jobs24h: jobStates,
    monitoring: monitors.rows[0] || { enabled: 0, failing: 0 },
    integrations24h: integrationStates,
    pendingApprovals: approvals.rows[0]?.pending || 0,
    openRegressions: regressions.rows[0]?.open || 0,
  };
}

export async function getPlatformOperatorOverview(limit = 100) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const [summary, workspaces, alerts] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM workspaces WHERE status = 'ACTIVE')::int AS active_workspaces,
         (SELECT COUNT(*) FROM platform_users WHERE status = 'ACTIVE')::int AS active_users,
         (SELECT COUNT(*) FROM approval_requests
           WHERE status = 'PENDING' AND expires_at > now())::int AS pending_approvals,
         (SELECT COUNT(*) FROM integration_outbox
           WHERE state = 'DEAD_LETTER')::int AS integration_dead_letters,
         (SELECT COUNT(*) FROM jobs
           WHERE state IN ('FAILED','DEAD_LETTER')
             AND created_at >= now() - interval '24 hours')::int AS failed_jobs_24h`,
    ),
    pool.query(
      `SELECT w.id, w.name, w.slug, w.status,
              COALESCE(s.plan,w.plan) AS plan,
              COALESCE(s.status,'ACTIVE') AS subscription_status,
              s.trial_ends_at,
              (SELECT COUNT(*) FROM targets t WHERE t.workspace_id = w.id)::int AS targets,
              (SELECT COUNT(*) FROM workspace_memberships m WHERE m.workspace_id = w.id)::int AS members
         FROM workspaces w
         LEFT JOIN workspace_subscriptions s ON s.workspace_id = w.id
        ORDER BY w.created_at DESC
        LIMIT $1`,
      [safeLimit],
    ),
    pool.query(
      `SELECT 'INTEGRATION_DEAD_LETTER' AS kind,
              o.workspace_id,
              o.id::text AS subject_id,
              o.last_error_code AS detail,
              o.updated_at AS occurred_at
         FROM integration_outbox o
        WHERE o.state = 'DEAD_LETTER'
       UNION ALL
       SELECT 'FAILED_JOB' AS kind,
              t.workspace_id,
              j.id::text AS subject_id,
              COALESCE(j.error->>'code','FAILED') AS detail,
              COALESCE(j.completed_at,j.created_at) AS occurred_at
         FROM jobs j
         JOIN targets t ON t.id = j.target_id
        WHERE j.state IN ('FAILED','DEAD_LETTER')
          AND j.created_at >= now() - interval '24 hours'
        ORDER BY occurred_at DESC
        LIMIT $1`,
      [safeLimit],
    ),
  ]);
  return {
    summary: summary.rows[0],
    workspaces: workspaces.rows,
    alerts: alerts.rows,
  };
}
