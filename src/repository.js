import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
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
         input
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, target_id, authorization_id, job_type, capability,
                 requested_url, state, input, created_at`,
      [
        targetId,
        authorizationId,
        jobType,
        capability,
        requestedUrl,
        JSON.stringify(input || {}),
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
            started_at, completed_at
       FROM jobs
      WHERE id = $1`,
    [jobId],
  );

  return result.rows[0] ? mapJob(result.rows[0]) : null;
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
  };
}
