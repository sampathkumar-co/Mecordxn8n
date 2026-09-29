import { pool } from "../repository.js";

function mapFinding(row) {
  return {
    id: row.id,
    targetId: row.target_id,
    fingerprint: row.fingerprint,
    category: row.category,
    title: row.title,
    severity: row.severity,
    confidence: Number(row.confidence),
    affectedUrl: row.affected_url,
    evidence: row.evidence,
    occurrences: row.occurrences,
    status: row.status,
    verificationState: row.verification_state,
    rootCauseKey: row.root_cause_key,
    verifiedAt: row.verified_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

async function lockedLease(client, jobId, workerId) {
  const result = await client.query(
    `SELECT id, target_id, input
       FROM jobs
      WHERE id = $1
        AND state = 'RUNNING'
        AND lease_owner = $2
        AND lease_expires_at > now()
      FOR UPDATE`,
    [jobId, workerId],
  );
  return result.rows[0] || null;
}

export async function getTarget(targetId) {
  const result = await pool.query(
    `SELECT id, organization_name, base_url, created_at
       FROM targets WHERE id = $1`,
    [targetId],
  );
  const row = result.rows[0];
  return row
    ? {
        id: row.id,
        organizationName: row.organization_name,
        baseUrl: row.base_url,
        createdAt: row.created_at,
      }
    : null;
}

export async function getFindingContext(findingId) {
  const result = await pool.query(
    `SELECT f.*,
            v.id AS verification_id,
            v.status AS latest_verification_status,
            v.confidence AS latest_verification_confidence,
            v.evidence AS latest_verification_evidence,
            v.created_at AS latest_verification_created_at,
            i.business_impact_score,
            i.buyer_relevance,
            i.repair_feasibility,
            i.engineering_effort,
            i.opportunity_score,
            i.impact_tier,
            i.affected_journey,
            i.rationale,
            i.inputs AS intelligence_inputs
       FROM findings f
       LEFT JOIN LATERAL (
         SELECT * FROM finding_verifications
          WHERE finding_id = f.id
          ORDER BY created_at DESC
          LIMIT 1
       ) v ON true
       LEFT JOIN finding_intelligence i ON i.finding_id = f.id
      WHERE f.id = $1`,
    [findingId],
  );

  const row = result.rows[0];
  if (!row) return null;
  const finding = mapFinding(row);

  return {
    ...finding,
    verification: row.verification_id
      ? {
          id: row.verification_id,
          status: row.latest_verification_status,
          confidence: Number(row.latest_verification_confidence),
          evidence: row.latest_verification_evidence,
          createdAt: row.latest_verification_created_at,
        }
      : null,
    intelligence: row.opportunity_score == null
      ? null
      : {
          businessImpactScore: row.business_impact_score,
          buyerRelevance: row.buyer_relevance,
          repairFeasibility: row.repair_feasibility,
          engineeringEffort: row.engineering_effort,
          opportunityScore: Number(row.opportunity_score),
          impactTier: row.impact_tier,
          affectedJourney: row.affected_journey,
          rationale: row.rationale,
          inputs: row.intelligence_inputs,
        },
  };
}

export async function upsertSitePagesFromLease({
  jobId,
  workerId,
  pages,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await lockedLease(client, jobId, workerId);
    if (!job) {
      await client.query("ROLLBACK");
      return null;
    }

    let count = 0;
    for (const page of pages.slice(0, 200)) {
      await client.query(
        `INSERT INTO site_pages (
           target_id, url, source, status_code, title, metadata
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (target_id, url)
         DO UPDATE SET
           source = EXCLUDED.source,
           status_code = COALESCE(EXCLUDED.status_code, site_pages.status_code),
           title = COALESCE(EXCLUDED.title, site_pages.title),
           metadata = site_pages.metadata || EXCLUDED.metadata,
           last_seen_at = now()`,
        [
          job.target_id,
          page.url,
          page.source || "discovery",
          page.statusCode ?? null,
          page.title || null,
          JSON.stringify(page.metadata || {}),
        ],
      );
      count += 1;
    }

    await client.query(
      `INSERT INTO audit_events (target_id, job_id, event_type, payload)
       VALUES ($1, $2, 'SITE_PAGES_RECORDED', $3::jsonb)`,
      [job.target_id, jobId, JSON.stringify({ count })],
    );
    await client.query("COMMIT");
    return { count };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function recordJourneyRunFromLease({
  jobId,
  workerId,
  name,
  state,
  steps,
  evidence,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await lockedLease(client, jobId, workerId);
    if (!job) {
      await client.query("ROLLBACK");
      return null;
    }

    const result = await client.query(
      `INSERT INTO journey_runs (target_id, job_id, name, state, steps, evidence)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       RETURNING id, target_id, job_id, name, state, steps, evidence, created_at`,
      [
        job.target_id,
        jobId,
        name,
        state,
        JSON.stringify(steps),
        JSON.stringify(evidence || {}),
      ],
    );

    await client.query(
      `INSERT INTO audit_events (target_id, job_id, event_type, payload)
       VALUES ($1, $2, 'JOURNEY_RUN_RECORDED', $3::jsonb)`,
      [job.target_id, jobId, JSON.stringify({ journeyRunId: result.rows[0].id, state })],
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

export async function recordVerificationFromLease({
  jobId,
  workerId,
  findingId,
  status,
  attempts,
  matchedAttempts,
  confidence,
  evidence,
  artifacts,
  intelligence,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await lockedLease(client, jobId, workerId);
    if (!job) {
      await client.query("ROLLBACK");
      return null;
    }

    const findingResult = await client.query(
      "SELECT id, target_id FROM findings WHERE id = $1 FOR UPDATE",
      [findingId],
    );
    const finding = findingResult.rows[0];
    if (!finding || finding.target_id !== job.target_id) {
      await client.query("ROLLBACK");
      return null;
    }

    const verification = await client.query(
      `INSERT INTO finding_verifications (
         finding_id, job_id, status, attempts, matched_attempts, confidence, evidence
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING id, finding_id, status, attempts, matched_attempts,
                 confidence, evidence, created_at`,
      [
        findingId,
        jobId,
        status,
        attempts,
        matchedAttempts,
        confidence,
        JSON.stringify(evidence || {}),
      ],
    );
    const verificationRow = verification.rows[0];

    await client.query(
      `UPDATE findings
          SET verification_state = $2,
              verified_at = CASE WHEN $2 = 'VERIFIED' THEN now() ELSE verified_at END,
              status = CASE WHEN $2 = 'VERIFIED' THEN 'VERIFIED' ELSE status END
        WHERE id = $1`,
      [findingId, status === "VERIFIED" ? "VERIFIED" : "NOT_REPRODUCED"],
    );

    if (intelligence) {
      await client.query(
        `INSERT INTO finding_intelligence (
           finding_id, business_impact_score, buyer_relevance,
           repair_feasibility, engineering_effort, opportunity_score,
           impact_tier, affected_journey, rationale, inputs
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
         ON CONFLICT (finding_id)
         DO UPDATE SET
           business_impact_score = EXCLUDED.business_impact_score,
           buyer_relevance = EXCLUDED.buyer_relevance,
           repair_feasibility = EXCLUDED.repair_feasibility,
           engineering_effort = EXCLUDED.engineering_effort,
           opportunity_score = EXCLUDED.opportunity_score,
           impact_tier = EXCLUDED.impact_tier,
           affected_journey = EXCLUDED.affected_journey,
           rationale = EXCLUDED.rationale,
           inputs = EXCLUDED.inputs,
           computed_at = now()`,
        [
          findingId,
          intelligence.businessImpactScore,
          intelligence.buyerRelevance,
          intelligence.repairFeasibility,
          intelligence.engineeringEffort,
          intelligence.opportunityScore,
          intelligence.impactTier,
          intelligence.affectedJourney,
          intelligence.rationale,
          JSON.stringify(intelligence.inputs || {}),
        ],
      );
    }

    for (const artifact of (artifacts || []).slice(0, 20)) {
      await client.query(
        `INSERT INTO evidence_artifacts (
           target_id, finding_id, verification_id, kind, path,
           sha256, byte_length, metadata
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          job.target_id,
          findingId,
          verificationRow.id,
          artifact.kind || artifact.type || "artifact",
          artifact.path || null,
          artifact.sha256 || null,
          artifact.byteLength || null,
          JSON.stringify(artifact.metadata || {}),
        ],
      );
    }

    await client.query(
      `INSERT INTO audit_events (target_id, job_id, event_type, payload)
       VALUES ($1,$2,'FINDING_VERIFIED',$3::jsonb)`,
      [
        job.target_id,
        jobId,
        JSON.stringify({
          findingId,
          verificationId: verificationRow.id,
          status,
          confidence,
        }),
      ],
    );

    await client.query("COMMIT");
    return verificationRow;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createRemediationRequest({
  targetId,
  findingId,
  jobId,
  projectRoot,
}) {
  const result = await pool.query(
    `INSERT INTO remediation_requests (
       target_id, finding_id, job_id, project_root
     )
     VALUES ($1,$2,$3,$4)
     RETURNING *`,
    [targetId, findingId, jobId, projectRoot],
  );
  return result.rows[0];
}

export async function recordRemediationResultFromLease({
  jobId,
  workerId,
  status,
  mcpRequestId,
  mcpResult,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await lockedLease(client, jobId, workerId);
    if (!job) {
      await client.query("ROLLBACK");
      return null;
    }

    const result = await client.query(
      `UPDATE remediation_requests
          SET status = $2,
              mcp_request_id = $3,
              mcp_result = $4::jsonb,
              completed_at = now()
        WHERE job_id = $1
        RETURNING *`,
      [jobId, status, mcpRequestId || null, JSON.stringify(mcpResult || null)],
    );

    await client.query(
      `INSERT INTO audit_events (target_id, job_id, event_type, payload)
       VALUES ($1,$2,'REMEDIATION_RESULT_RECORDED',$3::jsonb)`,
      [
        job.target_id,
        jobId,
        JSON.stringify({ status, remediationRequestId: result.rows[0]?.id || null }),
      ],
    );
    await client.query("COMMIT");
    return result.rows[0] || null;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listOpportunityFindings(targetId) {
  const result = await pool.query(
    `SELECT f.*,
            v.id AS verification_id,
            v.status AS verification_status,
            v.confidence AS verification_confidence,
            v.evidence AS verification_evidence,
            i.business_impact_score,
            i.buyer_relevance,
            i.repair_feasibility,
            i.engineering_effort,
            i.opportunity_score,
            i.impact_tier,
            i.affected_journey,
            i.rationale,
            i.inputs AS intelligence_inputs
       FROM findings f
       JOIN LATERAL (
         SELECT * FROM finding_verifications
          WHERE finding_id = f.id AND status = 'VERIFIED'
          ORDER BY created_at DESC
          LIMIT 1
       ) v ON true
       LEFT JOIN finding_intelligence i ON i.finding_id = f.id
      WHERE f.target_id = $1
      ORDER BY i.opportunity_score DESC NULLS LAST, f.last_seen_at DESC`,
    [targetId],
  );

  return result.rows.map((row) => ({
    ...mapFinding(row),
    verification: {
      id: row.verification_id,
      status: row.verification_status,
      confidence: Number(row.verification_confidence),
      evidence: row.verification_evidence,
    },
    intelligence: row.opportunity_score == null ? null : {
      businessImpactScore: row.business_impact_score,
      buyerRelevance: row.buyer_relevance,
      repairFeasibility: row.repair_feasibility,
      engineeringEffort: row.engineering_effort,
      opportunityScore: Number(row.opportunity_score),
      impactTier: row.impact_tier,
      affectedJourney: row.affected_journey,
      rationale: row.rationale,
      inputs: row.intelligence_inputs,
    },
  }));
}

export async function saveReport({
  targetId,
  kind,
  markdown,
  summary,
}) {
  const result = await pool.query(
    `INSERT INTO reports (target_id, kind, markdown, summary)
     VALUES ($1,$2,$3,$4::jsonb)
     RETURNING id, target_id, kind, status, markdown, summary, created_at`,
    [targetId, kind, markdown, JSON.stringify(summary || {})],
  );
  return result.rows[0];
}

export async function getReport(reportId) {
  const result = await pool.query(
    `SELECT id, target_id, kind, status, markdown, summary, created_at
       FROM reports WHERE id = $1`,
    [reportId],
  );
  return result.rows[0] || null;
}
