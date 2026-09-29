import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
});

export async function pingDatabase() {
  await pool.query("SELECT 1");
}

export async function createTargetWithAuthorization({
  organizationName,
  baseUrl,
  authorization,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const targetResult = await client.query(
      `INSERT INTO targets (organization_name, base_url)
       VALUES ($1, $2)
       RETURNING id, organization_name, base_url, created_at`,
      [organizationName, baseUrl],
    );

    const target = targetResult.rows[0];

    const authResult = await client.query(
      `INSERT INTO authorizations (
         target_id,
         mode,
         allowed_hosts,
         allowed_capabilities,
         scope_notes,
         evidence_reference,
         expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, target_id, mode, allowed_hosts, allowed_capabilities,
                 scope_notes, evidence_reference, expires_at, created_at`,
      [
        target.id,
        authorization.mode,
        authorization.allowedHosts,
        authorization.allowedCapabilities || [],
        authorization.scopeNotes || null,
        authorization.evidenceReference || null,
        authorization.expiresAt || null,
      ],
    );

    const auth = authResult.rows[0];

    await client.query(
      `INSERT INTO audit_events (target_id, event_type, payload)
       VALUES ($1, 'TARGET_REGISTERED', $2::jsonb)`,
      [
        target.id,
        JSON.stringify({
          authorizationId: auth.id,
          mode: auth.mode,
          allowedHosts: auth.allowed_hosts,
          allowedCapabilities: auth.allowed_capabilities,
        }),
      ],
    );

    await client.query("COMMIT");

    return {
      id: target.id,
      organizationName: target.organization_name,
      baseUrl: target.base_url,
      createdAt: target.created_at,
      authorization: mapAuthorization(auth),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getCurrentAuthorization(targetId) {
  const result = await pool.query(
    `SELECT id, target_id, mode, allowed_hosts, allowed_capabilities,
            scope_notes, evidence_reference, expires_at, created_at
       FROM authorizations
      WHERE target_id = $1
        AND revoked_at IS NULL
      LIMIT 1`,
    [targetId],
  );

  return result.rows[0] ? mapAuthorization(result.rows[0]) : null;
}

export async function createAuthorizedJob({
  targetId,
  authorizationId,
  jobType,
  capability,
  requestedUrl,
  input,
  decision,
  maxAttempts = 3,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `INSERT INTO jobs (
         target_id,
         authorization_id,
         job_type,
         capability,
         requested_url,
         input,
         max_attempts
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       RETURNING id, target_id, authorization_id, job_type, capability,
                 requested_url, state, input, output, error, created_at,
                 started_at, completed_at, lease_owner, lease_expires_at,
                 attempt_count, max_attempts, next_attempt_at,
                 last_heartbeat_at, cost_units`,
      [
        targetId,
        authorizationId,
        jobType,
        capability,
        requestedUrl,
        JSON.stringify(input || {}),
        Math.min(Math.max(Number(maxAttempts) || 3, 1), 10),
      ],
    );

    const job = result.rows[0];

    await client.query(
      `INSERT INTO audit_events (target_id, job_id, event_type, payload)
       VALUES ($1, $2, 'JOB_AUTHORIZED_AND_QUEUED', $3::jsonb)`,
      [
        targetId,
        job.id,
        JSON.stringify({
          mode: decision.mode,
          host: decision.host,
          capability: decision.capability,
        }),
      ],
    );

    await client.query("COMMIT");
    return mapJob(job);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordDeniedJob({
  targetId,
  jobType,
  capability,
  requestedUrl,
  code,
  message,
}) {
  await pool.query(
    `INSERT INTO audit_events (target_id, event_type, payload)
     VALUES ($1, 'JOB_DENIED', $2::jsonb)`,
    [
      targetId || null,
      JSON.stringify({
        jobType,
        capability,
        requestedUrl,
        code,
        message,
      }),
    ],
  );
}

export async function getJob(jobId) {
  const result = await pool.query(
    `SELECT id, target_id, authorization_id, job_type, capability,
            requested_url, state, input, output, error, created_at,
            started_at, completed_at, lease_owner, lease_expires_at,
            attempt_count, max_attempts, next_attempt_at,
            last_heartbeat_at, cost_units
       FROM jobs
      WHERE id = $1`,
    [jobId],
  );

  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

export async function leaseNextJob({
  workerId,
  capabilities,
  leaseSeconds = 60,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `WITH candidate AS (
         SELECT id
           FROM jobs
          WHERE capability = ANY($1::text[])
            AND attempt_count < max_attempts
            AND (
              (
                state = 'QUEUED'
                AND (next_attempt_at IS NULL OR next_attempt_at <= now())
              )
              OR (
                state = 'RUNNING'
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= now()
              )
            )
          ORDER BY COALESCE(next_attempt_at, created_at), created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE jobs AS j
          SET state = 'RUNNING',
              lease_owner = $2,
              lease_expires_at = now() + ($3 * interval '1 second'),
              attempt_count = j.attempt_count + 1,
              next_attempt_at = NULL,
              last_heartbeat_at = now(),
              started_at = COALESCE(j.started_at, now())
         FROM candidate
        WHERE j.id = candidate.id
       RETURNING j.id, j.target_id, j.authorization_id, j.job_type,
                 j.capability, j.requested_url, j.state, j.input,
                 j.output, j.error, j.created_at, j.started_at,
                 j.completed_at, j.lease_owner, j.lease_expires_at,
                 j.attempt_count, j.max_attempts, j.next_attempt_at,
                 j.last_heartbeat_at, j.cost_units`,
      [capabilities, workerId, leaseSeconds],
    );

    if (result.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }

    const job = result.rows[0];

    await client.query(
      `INSERT INTO audit_events (target_id, job_id, event_type, payload)
       VALUES ($1, $2, 'JOB_LEASED', $3::jsonb)`,
      [
        job.target_id,
        job.id,
        JSON.stringify({
          workerId,
          leaseExpiresAt: job.lease_expires_at,
          attemptCount: job.attempt_count,
        }),
      ],
    );

    await client.query("COMMIT");
    return mapJob(job);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertFindingFromLease({
  jobId,
  workerId,
  finding,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const jobResult = await client.query(
      `SELECT id, target_id
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

    const result = await client.query(
      `INSERT INTO findings (
         target_id,
         first_job_id,
         last_job_id,
         fingerprint,
         category,
         title,
         severity,
         confidence,
         affected_url,
         evidence
       )
       VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (target_id, fingerprint)
       DO UPDATE SET
         last_job_id = EXCLUDED.last_job_id,
         category = EXCLUDED.category,
         title = EXCLUDED.title,
         severity = EXCLUDED.severity,
         confidence = EXCLUDED.confidence,
         affected_url = EXCLUDED.affected_url,
         evidence = EXCLUDED.evidence,
         occurrences = findings.occurrences + 1,
         last_seen_at = now()
       RETURNING id, target_id, first_job_id, last_job_id, fingerprint,
                 category, title, severity, confidence, affected_url,
                 evidence, occurrences, status, first_seen_at, last_seen_at`,
      [
        job.target_id,
        jobId,
        finding.fingerprint,
        finding.category,
        finding.title,
        finding.severity,
        finding.confidence,
        finding.affectedUrl,
        JSON.stringify(finding.evidence || {}),
      ],
    );

    await client.query(
      `INSERT INTO audit_events (target_id, job_id, event_type, payload)
       VALUES ($1, $2, 'FINDING_RECORDED', $3::jsonb)`,
      [
        job.target_id,
        jobId,
        JSON.stringify({
          findingId: result.rows[0].id,
          fingerprint: finding.fingerprint,
        }),
      ],
    );

    await client.query("COMMIT");
    return mapFinding(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeLeasedJob({
  jobId,
  workerId,
  state,
  output,
  error,
}) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE jobs
          SET state = CASE
                WHEN $3 = 'FAILED' AND attempt_count < max_attempts THEN 'QUEUED'
                WHEN $3 = 'FAILED' AND attempt_count >= max_attempts THEN 'DEAD_LETTER'
                ELSE $3
              END,
              output = $4::jsonb,
              error = $5::jsonb,
              completed_at = CASE
                WHEN $3 = 'FAILED' AND attempt_count < max_attempts THEN NULL
                ELSE now()
              END,
              next_attempt_at = CASE
                WHEN $3 = 'FAILED' AND attempt_count < max_attempts
                  THEN now() + (LEAST(300, 5 * power(2, GREATEST(attempt_count - 1, 0))) * interval '1 second')
                ELSE NULL
              END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_heartbeat_at = now()
        WHERE id = $1
          AND lease_owner = $2
          AND state = 'RUNNING'
          AND lease_expires_at > now()
       RETURNING id, target_id, authorization_id, job_type, capability,
                 requested_url, state, input, output, error, created_at,
                 started_at, completed_at, lease_owner, lease_expires_at,
                 attempt_count, max_attempts, next_attempt_at,
                 last_heartbeat_at, cost_units`,
      [
        jobId,
        workerId,
        state,
        JSON.stringify(output || null),
        JSON.stringify(error || null),
      ],
    );

    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const job = result.rows[0];
    const eventType =
      job.state === "SUCCEEDED"
        ? "JOB_SUCCEEDED"
        : job.state === "DEAD_LETTER"
          ? "JOB_DEAD_LETTERED"
          : "JOB_RETRY_SCHEDULED";

    await client.query(
      `INSERT INTO audit_events (target_id, job_id, event_type, payload)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [
        job.target_id,
        job.id,
        eventType,
        JSON.stringify({
          workerId,
          resultingState: job.state,
          nextAttemptAt: job.next_attempt_at,
          attemptCount: job.attempt_count,
          maxAttempts: job.max_attempts,
        }),
      ],
    );

    if (job.state === "DEAD_LETTER") {
      await client.query(
        `INSERT INTO operational_events (
           component, event_type, severity, job_id, target_id, payload
         ) VALUES ('queue', 'JOB_DEAD_LETTERED', 'ERROR', $1, $2, $3::jsonb)`,
        [
          job.id,
          job.target_id,
          JSON.stringify({ attemptCount: job.attempt_count }),
        ],
      );
    }

    await client.query("COMMIT");
    return mapJob(job);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeatLeasedJob({
  jobId,
  workerId,
  leaseSeconds = 60,
}) {
  const safeSeconds = Math.min(Math.max(Number(leaseSeconds) || 60, 15), 300);
  const result = await pool.query(
    `UPDATE jobs
        SET lease_expires_at = now() + ($3 * interval '1 second'),
            last_heartbeat_at = now()
      WHERE id = $1
        AND lease_owner = $2
        AND state = 'RUNNING'
        AND lease_expires_at > now()
      RETURNING id, lease_expires_at, last_heartbeat_at`,
    [jobId, workerId, safeSeconds],
  );
  return result.rows[0] || null;
}

export async function sweepExhaustedJobs() {
  const result = await pool.query(
    `UPDATE jobs
        SET state = 'DEAD_LETTER',
            completed_at = now(),
            lease_owner = NULL,
            lease_expires_at = NULL
      WHERE state IN ('QUEUED', 'RUNNING')
        AND attempt_count >= max_attempts
        AND (
          state = 'QUEUED'
          OR lease_expires_at IS NULL
          OR lease_expires_at <= now()
        )
      RETURNING id, target_id, attempt_count`,
  );

  for (const row of result.rows) {
    await pool.query(
      `INSERT INTO operational_events (
         component, event_type, severity, job_id, target_id, payload
       ) VALUES ('queue', 'JOB_DEAD_LETTERED', 'ERROR', $1, $2, $3::jsonb)`,
      [row.id, row.target_id, JSON.stringify({ attemptCount: row.attempt_count })],
    );
  }

  return result.rows.length;
}

export async function recordJobCost({ jobId, costUnits }) {
  const units = Math.max(0, Number(costUnits) || 0);
  const result = await pool.query(
    `WITH updated AS (
       UPDATE jobs
          SET cost_units = cost_units + $2
        WHERE id = $1
        RETURNING target_id
     )
     INSERT INTO daily_usage (target_id, usage_date, cost_units, job_count)
     SELECT target_id, CURRENT_DATE, $2, 1 FROM updated
     ON CONFLICT (target_id, usage_date)
     DO UPDATE SET
       cost_units = daily_usage.cost_units + EXCLUDED.cost_units,
       job_count = daily_usage.job_count + 1
     RETURNING target_id, usage_date, cost_units, job_count`,
    [jobId, units],
  );
  return result.rows[0] || null;
}

export async function closePool() {
  await pool.end();
}

function mapAuthorization(row) {
  return {
    id: row.id,
    targetId: row.target_id,
    mode: row.mode,
    allowedHosts: row.allowed_hosts || [],
    allowedCapabilities: row.allowed_capabilities || [],
    scopeNotes: row.scope_notes,
    evidenceReference: row.evidence_reference,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function mapJob(row) {
  return {
    id: row.id,
    targetId: row.target_id,
    authorizationId: row.authorization_id,
    jobType: row.job_type,
    capability: row.capability,
    requestedUrl: row.requested_url,
    state: row.state,
    input: row.input,
    output: row.output,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    costUnits: Number(row.cost_units || 0),
  };
}

function mapFinding(row) {
  return {
    id: row.id,
    targetId: row.target_id,
    firstJobId: row.first_job_id,
    lastJobId: row.last_job_id,
    fingerprint: row.fingerprint,
    category: row.category,
    title: row.title,
    severity: row.severity,
    confidence: Number(row.confidence),
    affectedUrl: row.affected_url,
    evidence: row.evidence,
    occurrences: row.occurrences,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}
