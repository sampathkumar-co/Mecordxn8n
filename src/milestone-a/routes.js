import {
  CAPABILITIES,
  assertAuthorized,
} from "../authorization.js";
import {
  createAuthorizedJob,
  getCurrentAuthorization,
} from "../repository.js";
import {
  createRemediationRequest,
  getFindingContext,
  getReport,
  getTarget,
  listOpportunityFindings,
  markFindingVerifying,
  recordJourneyRunFromLease,
  recordRemediationResultFromLease,
  recordVerificationFromLease,
  saveReport,
  upsertSitePagesFromLease,
} from "./repository.js";
import { buildClientProposal } from "./report.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validId(value) {
  return UUID_RE.test(String(value || ""));
}

async function queueTargetJob({
  targetId,
  requestedUrl,
  capability,
  jobType,
  input,
}) {
  const target = await getTarget(targetId);
  if (!target) {
    const error = new Error("target not found");
    error.statusCode = 404;
    throw error;
  }

  const authorization = await getCurrentAuthorization(targetId);
  const decision = assertAuthorized({
    authorization,
    requestedCapability: capability,
    requestedUrl,
  });

  return createAuthorizedJob({
    targetId,
    authorizationId: authorization.id,
    jobType,
    capability,
    requestedUrl,
    input,
    decision,
  });
}

export async function handleMilestoneARoute({
  req,
  res,
  url,
  json,
  readJson,
  badRequest,
}) {
  let match;

  match = url.pathname.match(/^\/v1\/worker\/milestone-a\/findings\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("finding id is invalid");
    const finding = await getFindingContext(match[1]);
    if (!finding) return json(res, 404, { error: "FINDING_NOT_FOUND" });
    return json(res, 200, finding);
  }

  match = url.pathname.match(/^\/v1\/worker\/milestone-a\/jobs\/([0-9a-f-]+)\/pages$/i);
  if (req.method === "POST" && match) {
    const body = await readJson(req);
    if (!body.workerId?.trim()) throw badRequest("workerId is required");
    if (!Array.isArray(body.pages)) throw badRequest("pages must be an array");
    const result = await upsertSitePagesFromLease({
      jobId: match[1],
      workerId: body.workerId.trim(),
      pages: body.pages,
    });
    if (!result) return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
    return json(res, 201, result);
  }

  match = url.pathname.match(/^\/v1\/worker\/milestone-a\/jobs\/([0-9a-f-]+)\/journey-run$/i);
  if (req.method === "POST" && match) {
    const body = await readJson(req);
    if (!body.workerId?.trim()) throw badRequest("workerId is required");
    if (!["PASSED", "FAILED", "PARTIAL"].includes(body.state)) {
      throw badRequest("journey state is invalid");
    }
    const result = await recordJourneyRunFromLease({
      jobId: match[1],
      workerId: body.workerId.trim(),
      name: String(body.name || "journey").slice(0, 120),
      state: body.state,
      steps: Array.isArray(body.steps) ? body.steps : [],
      evidence: body.evidence || {},
    });
    if (!result) return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
    return json(res, 201, result);
  }

  match = url.pathname.match(/^\/v1\/worker\/milestone-a\/jobs\/([0-9a-f-]+)\/verification$/i);
  if (req.method === "POST" && match) {
    const body = await readJson(req);
    if (!body.workerId?.trim()) throw badRequest("workerId is required");
    if (!validId(body.findingId)) throw badRequest("findingId is invalid");
    if (!["VERIFIED", "NOT_REPRODUCED", "INCONCLUSIVE"].includes(body.status)) {
      throw badRequest("verification status is invalid");
    }
    const result = await recordVerificationFromLease({
      jobId: match[1],
      workerId: body.workerId.trim(),
      findingId: body.findingId,
      status: body.status,
      attempts: Number(body.attempts),
      matchedAttempts: Number(body.matchedAttempts),
      confidence: Number(body.confidence),
      evidence: body.evidence || {},
      artifacts: Array.isArray(body.artifacts) ? body.artifacts : [],
      intelligence: body.intelligence || null,
    });
    if (!result) return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
    return json(res, 201, result);
  }

  match = url.pathname.match(/^\/v1\/worker\/milestone-a\/jobs\/([0-9a-f-]+)\/remediation-result$/i);
  if (req.method === "POST" && match) {
    const body = await readJson(req);
    if (!body.workerId?.trim()) throw badRequest("workerId is required");
    if (!["SUCCEEDED", "FAILED", "BLOCKED"].includes(body.status)) {
      throw badRequest("remediation status is invalid");
    }
    const result = await recordRemediationResultFromLease({
      jobId: match[1],
      workerId: body.workerId.trim(),
      status: body.status,
      mcpRequestId: body.mcpRequestId || null,
      mcpResult: body.mcpResult || null,
    });
    if (!result) return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
    return json(res, 200, result);
  }

  match = url.pathname.match(/^\/v1\/targets\/([0-9a-f-]+)\/discover$/i);
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    const body = await readJson(req);
    const target = await getTarget(match[1]);
    if (!target) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    const requestedUrl = body.requestedUrl || target.baseUrl;
    const job = await queueTargetJob({
      targetId: match[1],
      requestedUrl,
      capability: CAPABILITIES.SITE_DISCOVERY,
      jobType: "site-discovery",
      input: {},
    });
    return json(res, 201, job);
  }

  match = url.pathname.match(/^\/v1\/targets\/([0-9a-f-]+)\/journeys$/i);
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    const body = await readJson(req);
    if (!Array.isArray(body.steps) || body.steps.length < 1 || body.steps.length > 20) {
      throw badRequest("steps must contain 1 to 20 read-only journey steps");
    }
    const target = await getTarget(match[1]);
    if (!target) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    const requestedUrl = body.requestedUrl || target.baseUrl;
    const job = await queueTargetJob({
      targetId: match[1],
      requestedUrl,
      capability: CAPABILITIES.JOURNEY_QA,
      jobType: "journey-qa",
      input: {
        name: String(body.name || "read-only journey").slice(0, 120),
        steps: body.steps,
      },
    });
    return json(res, 201, job);
  }

  match = url.pathname.match(/^\/v1\/findings\/([0-9a-f-]+)\/verify$/i);
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("finding id is invalid");
    const finding = await getFindingContext(match[1]);
    if (!finding) return json(res, 404, { error: "FINDING_NOT_FOUND" });
    const authorization = await getCurrentAuthorization(finding.targetId);
    const decision = assertAuthorized({
      authorization,
      requestedCapability: CAPABILITIES.FINDING_VERIFY,
      requestedUrl: finding.affectedUrl,
    });
    const job = await createAuthorizedJob({
      targetId: finding.targetId,
      authorizationId: authorization.id,
      jobType: "finding-verification",
      capability: CAPABILITIES.FINDING_VERIFY,
      requestedUrl: finding.affectedUrl,
      input: { findingId: finding.id, attempts: 2 },
      decision,
    });
    await markFindingVerifying(finding.id);
    return json(res, 201, job);
  }

  match = url.pathname.match(/^\/v1\/findings\/([0-9a-f-]+)\/remediate$/i);
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("finding id is invalid");
    const body = await readJson(req);
    if (!body.projectRoot?.trim()) throw badRequest("projectRoot is required");

    const finding = await getFindingContext(match[1]);
    if (!finding) return json(res, 404, { error: "FINDING_NOT_FOUND" });
    if (finding.verification?.status !== "VERIFIED") {
      return json(res, 409, { error: "FINDING_NOT_VERIFIED" });
    }

    const authorization = await getCurrentAuthorization(finding.targetId);
    const decision = assertAuthorized({
      authorization,
      requestedCapability: CAPABILITIES.SOURCE_REMEDIATION,
      requestedUrl: finding.affectedUrl,
    });

    const job = await createAuthorizedJob({
      targetId: finding.targetId,
      authorizationId: authorization.id,
      jobType: "source-remediation",
      capability: CAPABILITIES.SOURCE_REMEDIATION,
      requestedUrl: finding.affectedUrl,
      input: {
        findingId: finding.id,
        projectRoot: body.projectRoot.trim(),
      },
      decision,
    });

    const request = await createRemediationRequest({
      targetId: finding.targetId,
      findingId: finding.id,
      jobId: job.id,
      projectRoot: body.projectRoot.trim(),
    });

    return json(res, 201, { job, remediationRequest: request });
  }

  match = url.pathname.match(/^\/v1\/targets\/([0-9a-f-]+)\/opportunities$/i);
  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    return json(res, 200, { findings: await listOpportunityFindings(match[1]) });
  }

  match = url.pathname.match(/^\/v1\/targets\/([0-9a-f-]+)\/reports$/i);
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    const target = await getTarget(match[1]);
    if (!target) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    const findings = await listOpportunityFindings(match[1]);
    const markdown = buildClientProposal({ target, findings });
    const report = await saveReport({
      targetId: target.id,
      kind: "CLIENT_PROPOSAL",
      markdown,
      summary: {
        verifiedFindings: findings.length,
        topOpportunityScore: findings[0]?.intelligence?.opportunityScore || 0,
      },
    });
    return json(res, 201, report);
  }

  match = url.pathname.match(/^\/v1\/reports\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("report id is invalid");
    const report = await getReport(match[1]);
    if (!report) return json(res, 404, { error: "REPORT_NOT_FOUND" });
    return json(res, 200, report);
  }

  return false;
}
