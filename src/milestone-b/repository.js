import { pool } from "../repository.js";
import { compareSnapshots, snapshotFingerprint } from "./regression.js";

function mapApproval(row) {
  return {
    id: row.id,
    targetId: row.target_id,
    findingId: row.finding_id,
    reportId: row.report_id,
    actionType: row.action_type,
    payload: row.payload,
    status: row.status,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
  };
}

export async function getActiveLease(jobId, workerId) {
  const result = await pool.query(
    `SELECT id, target_id, input
       FROM jobs
      WHERE id = $1
        AND state = 'RUNNING'
        AND lease_owner = $2
        AND lease_expires_at > now()`,
    [jobId, workerId],
  );
  return result.rows[0] || null;
}

function mapPolicy(row) {
  return {
    id: row.id,
    targetId: row.target_id,
    name: row.name,
    capability: row.capability,
    requestedUrl: row.requested_url,
    input: row.input,
    cadenceMinutes: row.cadence_minutes,
    enabled: row.enabled,
    dailyBudgetUnits: Number(row.daily_budget_units),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    consecutiveFailures: row.consecutive_failures,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createApprovalRequest({
  targetId,
  findingId = null,
  reportId = null,
  actionType,
  payload,
  requestedBy = "system",
  expiresMinutes = 120,
}) {
  const safeMinutes = Math.min(Math.max(Number(expiresMinutes) || 120, 5), 1440);
  const result = await pool.query(
    `INSERT INTO approval_requests (
       target_id, finding_id, report_id, action_type, payload,
       requested_by, expires_at
     )
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,now() + ($7 * interval '1 minute'))
     RETURNING *`,
    [
      targetId,
      findingId,
      reportId,
      actionType,
      JSON.stringify(payload || {}),
      requestedBy,
      safeMinutes,
    ],
  );
  return mapApproval(result.rows[0]);
}

export async function getApprovalRequest(approvalId) {
  const result = await pool.query(
    "SELECT * FROM approval_requests WHERE id = $1",
    [approvalId],
  );
  return result.rows[0] ? mapApproval(result.rows[0]) : null;
}

export async function decideApprovalRequest({
  approvalId,
  decision,
  decidedBy,
  decisionNote = null,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT * FROM approval_requests WHERE id = $1 FOR UPDATE",
      [approvalId],
    );
    if (current.rowCount === 0) {
      await client.query("ROLLBACK");
      return { status: "NOT_FOUND", approval: null };
    }

    const row = current.rows[0];
    if (row.status !== "PENDING") {
      await client.query("ROLLBACK");
      return { status: "ALREADY_DECIDED", approval: mapApproval(row) };
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      const expired = await client.query(
        `UPDATE approval_requests
            SET status = 'EXPIRED', decided_at = now(),
                decided_by = $2, decision_note = $3
          WHERE id = $1
          RETURNING *`,
        [approvalId, decidedBy, decisionNote || "Approval expired before decision."],
      );
      await client.query("COMMIT");
      return { status: "EXPIRED", approval: mapApproval(expired.rows[0]) };
    }

    const updated = await client.query(
      `UPDATE approval_requests
          SET status = $2,
              decided_by = $3,
              decision_note = $4,
              decided_at = now()
        WHERE id = $1
        RETURNING *`,
      [approvalId, decision, decidedBy, decisionNote],
    );

    await client.query(
      `INSERT INTO audit_events (target_id, event_type, payload)
       VALUES ($1, 'APPROVAL_DECIDED', $2::jsonb)`,
      [
        row.target_id,
        JSON.stringify({
          approvalId,
          actionType: row.action_type,
          decision,
          decidedBy,
        }),
      ],
    );

    await client.query("COMMIT");
    return { status: decision, approval: mapApproval(updated.rows[0]) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function expirePendingApprovals() {
  const result = await pool.query(
    `UPDATE approval_requests
        SET status = 'EXPIRED',
            decided_at = now(),
            decision_note = COALESCE(decision_note, 'Expired automatically.')
      WHERE status = 'PENDING'
        AND expires_at <= now()
      RETURNING id, target_id`,
  );
  return result.rows.length;
}

export async function createMonitoringPolicy({
  targetId,
  name,
  capability,
  requestedUrl,
  input,
  cadenceMinutes,
  dailyBudgetUnits,
}) {
  const result = await pool.query(
    `INSERT INTO monitoring_policies (
       target_id, name, capability, requested_url, input,
       cadence_minutes, daily_budget_units
     )
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
     RETURNING *`,
    [
      targetId,
      name,
      capability,
      requestedUrl,
      JSON.stringify(input || {}),
      cadenceMinutes,
      dailyBudgetUnits,
    ],
  );
  return mapPolicy(result.rows[0]);
}

export async function listMonitoringPolicies(targetId) {
  const result = await pool.query(
    `SELECT * FROM monitoring_policies
      WHERE target_id = $1
      ORDER BY created_at DESC`,
    [targetId],
  );
  return result.rows.map(mapPolicy);
}

export async function setMonitoringPolicyEnabled(policyId, enabled) {
  const result = await pool.query(
    `UPDATE monitoring_policies
        SET enabled = $2, updated_at = now(),
            next_run_at = CASE WHEN $2 THEN LEAST(next_run_at, now()) ELSE next_run_at END
      WHERE id = $1
      RETURNING *`,
    [policyId, Boolean(enabled)],
  );
  return result.rows[0] ? mapPolicy(result.rows[0]) : null;
}

export async function claimDueMonitoringPolicies(limit = 25) {
  const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH due AS (
         SELECT id
           FROM monitoring_policies
          WHERE enabled = true
            AND next_run_at <= now()
          ORDER BY next_run_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       ),
       claimed AS (
         UPDATE monitoring_policies p
            SET next_run_at = now() + (p.cadence_minutes * interval '1 minute'),
                updated_at = now()
           FROM due
          WHERE p.id = due.id
         RETURNING p.*
       )
       SELECT c.*,
              COALESCE((
                SELECT SUM(r.cost_units)
                  FROM monitoring_runs r
                 WHERE r.policy_id = c.id
                   AND r.created_at >= date_trunc('day', now())
              ), 0) AS used_today
         FROM claimed c
        ORDER BY c.next_run_at`,
      [safeLimit],
    );
    await client.query("COMMIT");
    return result.rows.map((row) => ({
      ...mapPolicy(row),
      usedToday: Number(row.used_today || 0),
    }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordMonitoringRunFromLease({
  jobId,
  workerId,
  policyId,
  snapshot,
  costUnits = 1,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const jobResult = await client.query(
      `SELECT id, target_id, input
         FROM jobs
        WHERE id = $1
          AND state = 'RUNNING'
          AND lease_owner = $2
          AND lease_expires_at > now()
        FOR UPDATE`,
      [jobId, workerId],
    );
    if (jobResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const job = jobResult.rows[0];
    if (job.input?.monitoringPolicyId !== policyId) {
      await client.query("ROLLBACK");
      return null;
    }

    const policyResult = await client.query(
      `SELECT * FROM monitoring_policies
        WHERE id = $1 AND target_id = $2
        FOR UPDATE`,
      [policyId, job.target_id],
    );
    if (policyResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const existingRun = await client.query(
      `SELECT id, policy_id, state, fingerprint
         FROM monitoring_runs
        WHERE job_id = $1`,
      [jobId],
    );
    if (existingRun.rowCount > 0) {
      await client.query("COMMIT");
      return {
        id: existingRun.rows[0].id,
        policyId: existingRun.rows[0].policy_id,
        state: existingRun.rows[0].state,
        fingerprint: existingRun.rows[0].fingerprint,
        regressions: [],
        duplicate: true,
      };
    }

    const previousResult = await client.query(
      `SELECT snapshot
         FROM monitoring_runs
        WHERE policy_id = $1
          AND state IN ('BASELINE','HEALTHY','REGRESSION')
        ORDER BY created_at DESC
        LIMIT 1`,
      [policyId],
    );
    const previous = previousResult.rows[0]?.snapshot || null;
    const regressions = compareSnapshots(previous, snapshot);
    const runState = !previous
      ? "BASELINE"
      : regressions.length > 0
        ? "REGRESSION"
        : "HEALTHY";
    const fingerprint = snapshotFingerprint(snapshot);

    const runResult = await client.query(
      `INSERT INTO monitoring_runs (
         policy_id, job_id, state, snapshot, fingerprint, cost_units
       )
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       RETURNING *`,
      [
        policyId,
        jobId,
        runState,
        JSON.stringify(snapshot),
        fingerprint,
        Math.max(0, Number(costUnits) || 0),
      ],
    );
    const run = runResult.rows[0];

    if (regressions.length === 0 && previous) {
      await client.query(
        `UPDATE regressions
            SET status = 'RESOLVED', resolved_at = now()
          WHERE policy_id = $1 AND status = 'OPEN'`,
        [policyId],
      );
    } else {
      for (const regression of regressions) {
        await client.query(
          `INSERT INTO regressions (
             policy_id, monitoring_run_id, fingerprint,
             category, severity, summary, evidence
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
           ON CONFLICT (policy_id, fingerprint) WHERE status = 'OPEN'
           DO UPDATE SET
             monitoring_run_id = EXCLUDED.monitoring_run_id,
             severity = EXCLUDED.severity,
             summary = EXCLUDED.summary,
             evidence = EXCLUDED.evidence,
             created_at = now()`,
          [
            policyId,
            run.id,
            regression.fingerprint,
            regression.category,
            regression.severity,
            regression.summary,
            JSON.stringify(regression.evidence || {}),
          ],
        );
      }
    }

    await client.query(
      `UPDATE monitoring_policies
          SET last_run_at = now(),
              consecutive_failures = CASE WHEN $2 = 'REGRESSION'
                THEN consecutive_failures + 1 ELSE 0 END,
              updated_at = now()
        WHERE id = $1`,
      [policyId, runState],
    );

    await client.query(
      `UPDATE jobs SET cost_units = cost_units + $2 WHERE id = $1`,
      [jobId, Math.max(0, Number(costUnits) || 0)],
    );
    await client.query(
      `INSERT INTO daily_usage (target_id, usage_date, cost_units, job_count)
       VALUES ($1, CURRENT_DATE, $2, 1)
       ON CONFLICT (target_id, usage_date)
       DO UPDATE SET
         cost_units = daily_usage.cost_units + EXCLUDED.cost_units,
         job_count = daily_usage.job_count + 1`,
      [job.target_id, Math.max(0, Number(costUnits) || 0)],
    );

    await client.query(
      `INSERT INTO operational_events (
         component, event_type, severity, job_id, target_id, payload
       )
       VALUES ('monitoring', $3, $4, $1, $2, $5::jsonb)`,
      [
        jobId,
        job.target_id,
        runState === "REGRESSION" ? "REGRESSION_DETECTED" : "MONITOR_RUN_RECORDED",
        runState === "REGRESSION" ? "WARN" : "INFO",
        JSON.stringify({ policyId, runId: run.id, regressionCount: regressions.length }),
      ],
    );

    await client.query("COMMIT");
    return {
      id: run.id,
      policyId,
      state: runState,
      fingerprint,
      regressions,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordMonitoringFailure({
  policyId,
  jobId,
  workerId,
  error,
}) {
  const lease = await getActiveLease(jobId, workerId);
  if (!lease || lease.input?.monitoringPolicyId !== policyId) return null;

  const policy = await pool.query(
    `SELECT id FROM monitoring_policies
      WHERE id = $1 AND target_id = $2`,
    [policyId, lease.target_id],
  );
  if (policy.rowCount === 0) return null;

  await pool.query(
    `UPDATE monitoring_policies
        SET consecutive_failures = consecutive_failures + 1,
            last_run_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [policyId],
  );
  await pool.query(
    `INSERT INTO operational_events (
       component, event_type, severity, job_id, target_id, payload
     ) VALUES ('monitoring','MONITOR_RUN_FAILED','ERROR',$1,$2,$3::jsonb)`,
    [jobId, lease.target_id, JSON.stringify(error || {})],
  );
  return { recorded: true, targetId: lease.target_id };
}

export async function listOpenRegressions(targetId) {
  const result = await pool.query(
    `SELECT r.*, p.name AS policy_name, p.requested_url
       FROM regressions r
       JOIN monitoring_policies p ON p.id = r.policy_id
      WHERE p.target_id = $1 AND r.status = 'OPEN'
      ORDER BY r.created_at DESC`,
    [targetId],
  );
  return result.rows;
}

export async function recordRepairOutcome({
  remediationRequestId,
  finding,
  learning,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO repair_outcomes (
         remediation_request_id, finding_id, pattern_key,
         outcome, summary, lessons
       )
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        remediationRequestId,
        finding.id,
        learning.patternKey,
        learning.outcome,
        learning.summary,
        JSON.stringify(learning.lessons || {}),
      ],
    );

    await client.query(
      `INSERT INTO repair_patterns (
         pattern_key, category, root_cause_key, symptom_signature,
         successful_strategy, validation_strategy,
         success_count, failure_count, last_outcome
       )
       VALUES (
         $1,$2,$3,$4,$5::jsonb,$6::jsonb,
         CASE WHEN $7 = 'SUCCESS' THEN 1 ELSE 0 END,
         CASE WHEN $7 = 'FAILED' THEN 1 ELSE 0 END,
         $7
       )
       ON CONFLICT (pattern_key)
       DO UPDATE SET
         successful_strategy = CASE
           WHEN EXCLUDED.last_outcome = 'SUCCESS'
             THEN EXCLUDED.successful_strategy
           ELSE repair_patterns.successful_strategy
         END,
         validation_strategy = CASE
           WHEN EXCLUDED.last_outcome = 'SUCCESS'
             THEN EXCLUDED.validation_strategy
           ELSE repair_patterns.validation_strategy
         END,
         success_count = repair_patterns.success_count +
           CASE WHEN EXCLUDED.last_outcome = 'SUCCESS' THEN 1 ELSE 0 END,
         failure_count = repair_patterns.failure_count +
           CASE WHEN EXCLUDED.last_outcome = 'FAILED' THEN 1 ELSE 0 END,
         last_outcome = EXCLUDED.last_outcome,
         last_seen_at = now()`,
      [
        learning.patternKey,
        learning.category,
        learning.rootCauseKey,
        learning.symptomSignature,
        JSON.stringify(learning.successfulStrategy || {}),
        JSON.stringify(learning.validationStrategy || {}),
        learning.outcome,
      ],
    );

    await client.query("COMMIT");
    return learning.patternKey;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function lookupRepairPatterns({
  category,
  limit = 5,
}) {
  const result = await pool.query(
    `SELECT pattern_key, category, root_cause_key, symptom_signature,
            successful_strategy, validation_strategy,
            success_count, failure_count, last_outcome, last_seen_at
       FROM repair_patterns
      WHERE category = $1
        AND success_count > 0
      ORDER BY success_count DESC, last_seen_at DESC
      LIMIT $2`,
    [category, Math.min(Math.max(Number(limit) || 5, 1), 20)],
  );
  return result.rows.map((row) => ({
    patternKey: row.pattern_key,
    category: row.category,
    rootCauseKey: row.root_cause_key,
    symptomSignature: row.symptom_signature,
    successfulStrategy: row.successful_strategy,
    validationStrategy: row.validation_strategy,
    successCount: row.success_count,
    failureCount: row.failure_count,
    lastOutcome: row.last_outcome,
    lastSeenAt: row.last_seen_at,
  }));
}

export async function recordOperationalEvent({
  component,
  eventType,
  severity = "INFO",
  jobId = null,
  targetId = null,
  payload = {},
}) {
  await pool.query(
    `INSERT INTO operational_events (
       component, event_type, severity, job_id, target_id, payload
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [
      component,
      eventType,
      severity,
      jobId,
      targetId,
      JSON.stringify(payload),
    ],
  );
}

export async function cancelInvalidAuthorizationJobs() {
  const result = await pool.query(
    `UPDATE jobs j
        SET state = 'CANCELLED',
            completed_at = now(),
            error = '{"code":"AUTHORIZATION_NO_LONGER_VALID"}'::jsonb
       FROM authorizations a
      WHERE j.authorization_id = a.id
        AND j.state = 'QUEUED'
        AND (
          a.revoked_at IS NOT NULL
          OR (a.expires_at IS NOT NULL AND a.expires_at <= now())
        )
      RETURNING j.id, j.target_id`,
  );
  return result.rows.length;
}

export async function getOperationalMetrics() {
  const [jobs, approvals, monitors, regressions, errors, usage] = await Promise.all([
    pool.query(
      `SELECT state, COUNT(*)::int AS count
         FROM jobs GROUP BY state`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM approval_requests
        WHERE status = 'PENDING' AND expires_at > now()`,
    ),
    pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE enabled)::int AS enabled,
         COUNT(*) FILTER (WHERE enabled AND next_run_at <= now())::int AS due
         FROM monitoring_policies`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM regressions WHERE status = 'OPEN'`,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count
         FROM operational_events
        WHERE severity = 'ERROR'
          AND created_at >= now() - interval '24 hours'`,
    ),
    pool.query(
      `SELECT COALESCE(SUM(cost_units),0)::numeric AS cost_units,
              COALESCE(SUM(job_count),0)::int AS job_count
         FROM daily_usage
        WHERE usage_date = CURRENT_DATE`,
    ),
  ]);

  return {
    jobs: Object.fromEntries(jobs.rows.map((row) => [row.state, row.count])),
    pendingApprovals: approvals.rows[0].count,
    monitoring: monitors.rows[0],
    openRegressions: regressions.rows[0].count,
    errors24h: errors.rows[0].count,
    usageToday: {
      costUnits: Number(usage.rows[0].cost_units || 0),
      jobCount: usage.rows[0].job_count,
    },
  };
}

export async function findRemediationByApprovalId(approvalId) {
  const result = await pool.query(
    `SELECT j.*, r.id AS remediation_request_id,
            r.status AS remediation_status, r.project_root
       FROM jobs j
       LEFT JOIN remediation_requests r ON r.job_id = j.id
      WHERE j.input->>'approvalId' = $1
      ORDER BY j.created_at DESC
      LIMIT 1`,
    [approvalId],
  );
  return result.rows[0] || null;
}

export async function markReportApproved(reportId) {
  const result = await pool.query(
    `UPDATE reports
        SET status = 'APPROVED'
      WHERE id = $1 AND status = 'READY'
      RETURNING id, target_id, kind, status, markdown, summary, created_at`,
    [reportId],
  );
  return result.rows[0] || null;
}

export async function getRemediationRequestForJob(jobId) {
  const result = await pool.query(
    `SELECT id, target_id, finding_id, job_id, project_root, status,
            mcp_request_id, mcp_result, created_at, completed_at
       FROM remediation_requests
      WHERE job_id = $1
      LIMIT 1`,
    [jobId],
  );
  return result.rows[0] || null;
}
