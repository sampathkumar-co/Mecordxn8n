import {
  CAPABILITIES,
  AuthorizationError,
  assertAuthorized,
} from "../authorization.js";
import {
  createAuthorizedJob,
  getCurrentAuthorization,
  heartbeatLeasedJob,
  sweepExhaustedJobs,
} from "../repository.js";
import {
  createRemediationRequest,
  getFindingContext,
  getReport,
  getTarget,
} from "../milestone-a/repository.js";
import {
  createApprovalRequest,
  createMonitoringPolicy,
  decideApprovalRequest,
  expirePendingApprovals,
  getApprovalRequest,
  getOperationalMetrics,
  listDueMonitoringPolicies,
  listMonitoringPolicies,
  listOpenRegressions,
  lookupRepairPatterns,
  markMonitoringPolicyQueued,
  recordMonitoringFailure,
  recordMonitoringRunFromLease,
  getActiveLease,
  recordOperationalEvent,
  recordRepairOutcome,
  setMonitoringPolicyEnabled,
} from "./repository.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MONITOR_CAPABILITIES = new Set([
  CAPABILITIES.PUBLIC_HTTP_OBSERVE,
  CAPABILITIES.BROWSER_QA,
]);

function validId(value) {
  return UUID_RE.test(String(value || ""));
}

function authorize(args) {
  try {
    return assertAuthorized(args);
  } catch (error) {
    if (error instanceof AuthorizationError) error.statusCode = 403;
    throw error;
  }
}

async function queueApprovedRemediation(approval) {
  const existingFinding = await getFindingContext(approval.findingId);
  if (!existingFinding) {
    const error = new Error("finding not found");
    error.statusCode = 404;
    throw error;
  }

  const authorization = await getCurrentAuthorization(existingFinding.targetId);
  const decision = authorize({
    authorization,
    requestedCapability: CAPABILITIES.SOURCE_REMEDIATION,
    requestedUrl: existingFinding.affectedUrl,
  });

  const job = await createAuthorizedJob({
    targetId: existingFinding.targetId,
    authorizationId: authorization.id,
    jobType: "source-remediation",
    capability: CAPABILITIES.SOURCE_REMEDIATION,
    requestedUrl: existingFinding.affectedUrl,
    input: {
      findingId: existingFinding.id,
      projectRoot: approval.payload.projectRoot,
      approvalId: approval.id,
    },
    decision,
    maxAttempts: 2,
  });

  const remediationRequest = await createRemediationRequest({
    targetId: existingFinding.targetId,
    findingId: existingFinding.id,
    jobId: job.id,
    projectRoot: approval.payload.projectRoot,
  });

  return { job, remediationRequest };
}

export async function handleMilestoneBRoute({
  req,
  res,
  url,
  json,
  readJson,
  badRequest,
}) {
  let match;

  match = url.pathname.match(/^\/v1\/worker\/jobs\/([0-9a-f-]+)\/heartbeat$/i);
  if (req.method === "POST" && match) {
    const body = await readJson(req);
    if (!body.workerId?.trim()) throw badRequest("workerId is required");
    const heartbeat = await heartbeatLeasedJob({
      jobId: match[1],
      workerId: body.workerId.trim(),
      leaseSeconds: body.leaseSeconds || 120,
    });
    if (!heartbeat) {
      return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
    }
    return json(res, 200, heartbeat);
  }

  match = url.pathname.match(/^\/v1\/worker\/milestone-b\/jobs\/([0-9a-f-]+)\/monitoring-run$/i);
  if (req.method === "POST" && match) {
    const body = await readJson(req);
    if (!body.workerId?.trim()) throw badRequest("workerId is required");
    if (!validId(body.policyId)) throw badRequest("policyId is invalid");
    const result = await recordMonitoringRunFromLease({
      jobId: match[1],
      workerId: body.workerId.trim(),
      policyId: body.policyId,
      snapshot: body.snapshot || {},
      costUnits: body.costUnits ?? 1,
    });
    if (!result) {
      return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
    }
    return json(res, 201, result);
  }

  match = url.pathname.match(/^\/v1\/worker\/milestone-b\/jobs\/([0-9a-f-]+)\/monitoring-failure$/i);
  if (req.method === "POST" && match) {
    const body = await readJson(req);
    if (!validId(body.policyId)) throw badRequest("policyId is invalid");
    if (!body.workerId?.trim()) throw badRequest("workerId is required");
    const recorded = await recordMonitoringFailure({
      policyId: body.policyId,
      jobId: match[1],
      workerId: body.workerId.trim(),
      error: body.error || {},
    });
    if (!recorded) {
      return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
    }
    return json(res, 201, recorded);
  }

  match = url.pathname.match(/^\/v1\/worker\/milestone-b\/jobs\/([0-9a-f-]+)\/repair-outcome$/i);
  if (req.method === "POST" && match) {
    const body = await readJson(req);
    if (!body.workerId?.trim()) throw badRequest("workerId is required");
    const lease = await getActiveLease(match[1], body.workerId.trim());
    if (!lease) {
      return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
    }
    if (!validId(body.remediationRequestId)) {
      throw badRequest("remediationRequestId is invalid");
    }
    if (!validId(body.findingId)) throw badRequest("findingId is invalid");
    if (!["SUCCESS", "FAILED", "PARTIAL"].includes(body.learning?.outcome)) {
      throw badRequest("repair outcome is invalid");
    }
    const finding = await getFindingContext(body.findingId);
    if (!finding) return json(res, 404, { error: "FINDING_NOT_FOUND" });
    const patternKey = await recordRepairOutcome({
      remediationRequestId: body.remediationRequestId,
      finding,
      learning: body.learning,
    });
    return json(res, 201, { patternKey });
  }

  if (req.method === "GET" && url.pathname === "/v1/worker/milestone-b/repair-patterns") {
    const category = url.searchParams.get("category");
    if (!category) throw badRequest("category is required");
    return json(res, 200, {
      patterns: await lookupRepairPatterns({
        category,
        limit: url.searchParams.get("limit") || 5,
      }),
    });
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
    authorize({
      authorization,
      requestedCapability: CAPABILITIES.SOURCE_REMEDIATION,
      requestedUrl: finding.affectedUrl,
    });

    try {
      const approval = await createApprovalRequest({
        targetId: finding.targetId,
        findingId: finding.id,
        actionType: "SOURCE_REMEDIATION",
        payload: {
          projectRoot: body.projectRoot.trim(),
          findingId: finding.id,
        },
        requestedBy: body.requestedBy || "chat",
        expiresMinutes: body.expiresMinutes || 120,
      });
      return json(res, 202, {
        approvalRequired: true,
        approval,
      });
    } catch (error) {
      if (error.code === "23505") {
        return json(res, 409, { error: "APPROVAL_ALREADY_PENDING" });
      }
      throw error;
    }
  }

  match = url.pathname.match(/^\/v1\/approvals\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && match) {
    const approval = await getApprovalRequest(match[1]);
    if (!approval) return json(res, 404, { error: "APPROVAL_NOT_FOUND" });
    return json(res, 200, approval);
  }

  match = url.pathname.match(/^\/v1\/approvals\/([0-9a-f-]+)\/(approve|reject)$/i);
  if (req.method === "POST" && match) {
    const body = await readJson(req);
    if (!body.decidedBy?.trim()) throw badRequest("decidedBy is required");
    const decision = match[2] === "approve" ? "APPROVED" : "REJECTED";
    const result = await decideApprovalRequest({
      approvalId: match[1],
      decision,
      decidedBy: body.decidedBy.trim(),
      decisionNote: body.decisionNote || null,
    });

    if (result.status === "NOT_FOUND") {
      return json(res, 404, { error: "APPROVAL_NOT_FOUND" });
    }
    if (result.status === "EXPIRED") {
      return json(res, 409, { error: "APPROVAL_EXPIRED", approval: result.approval });
    }
    if (result.status === "ALREADY_DECIDED") {
      return json(res, 409, { error: "APPROVAL_ALREADY_DECIDED", approval: result.approval });
    }

    if (decision === "REJECTED") {
      return json(res, 200, { approval: result.approval });
    }

    if (result.approval.actionType === "SOURCE_REMEDIATION") {
      const queued = await queueApprovedRemediation(result.approval);
      return json(res, 201, {
        approval: result.approval,
        ...queued,
      });
    }

    if (result.approval.actionType === "REPORT_RELEASE") {
      return json(res, 200, { approval: result.approval });
    }

    return json(res, 200, { approval: result.approval });
  }

  match = url.pathname.match(/^\/v1\/reports\/([0-9a-f-]+)\/request-release$/i);
  if (req.method === "POST" && match) {
    const report = await getReport(match[1]);
    if (!report) return json(res, 404, { error: "REPORT_NOT_FOUND" });
    const body = await readJson(req);
    const approval = await createApprovalRequest({
      targetId: report.target_id,
      reportId: report.id,
      actionType: "REPORT_RELEASE",
      payload: { reportId: report.id },
      requestedBy: body.requestedBy || "chat",
      expiresMinutes: body.expiresMinutes || 120,
    });
    return json(res, 202, { approvalRequired: true, approval });
  }

  match = url.pathname.match(/^\/v1\/targets\/([0-9a-f-]+)\/monitors$/i);
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    const body = await readJson(req);
    if (!MONITOR_CAPABILITIES.has(body.capability)) {
      throw badRequest("monitor capability must be PUBLIC_HTTP_OBSERVE or BROWSER_QA");
    }
    const cadenceMinutes = Number(body.cadenceMinutes);
    if (!Number.isInteger(cadenceMinutes) || cadenceMinutes < 5 || cadenceMinutes > 10080) {
      throw badRequest("cadenceMinutes must be an integer from 5 to 10080");
    }
    const dailyBudgetUnits = Number(body.dailyBudgetUnits ?? 100);
    if (!Number.isFinite(dailyBudgetUnits) || dailyBudgetUnits <= 0) {
      throw badRequest("dailyBudgetUnits must be positive");
    }

    const target = await getTarget(match[1]);
    if (!target) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    const requestedUrl = body.requestedUrl || target.baseUrl;
    const authorization = await getCurrentAuthorization(target.id);
    authorize({
      authorization,
      requestedCapability: body.capability,
      requestedUrl,
    });

    const policy = await createMonitoringPolicy({
      targetId: target.id,
      name: String(body.name || "continuous monitor").slice(0, 120),
      capability: body.capability,
      requestedUrl,
      input: body.input || {},
      cadenceMinutes,
      dailyBudgetUnits,
    });
    return json(res, 201, policy);
  }

  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    return json(res, 200, { policies: await listMonitoringPolicies(match[1]) });
  }

  match = url.pathname.match(/^\/v1\/monitors\/([0-9a-f-]+)\/(enable|disable)$/i);
  if (req.method === "POST" && match) {
    const policy = await setMonitoringPolicyEnabled(match[1], match[2] === "enable");
    if (!policy) return json(res, 404, { error: "MONITOR_NOT_FOUND" });
    return json(res, 200, policy);
  }

  if (req.method === "POST" && url.pathname === "/v1/monitoring/tick") {
    const body = await readJson(req);
    await expirePendingApprovals();
    const deadLettered = await sweepExhaustedJobs();
    const due = await listDueMonitoringPolicies(body.limit || 25);
    const queued = [];
    const skipped = [];

    for (const policy of due) {
      const estimatedCost = policy.capability === CAPABILITIES.BROWSER_QA ? 1 : 0.25;
      if (policy.usedToday + estimatedCost > policy.dailyBudgetUnits) {
        skipped.push({ policyId: policy.id, reason: "DAILY_BUDGET_EXCEEDED" });
        await recordOperationalEvent({
          component: "monitoring",
          eventType: "MONITOR_BUDGET_SKIPPED",
          severity: "WARN",
          targetId: policy.targetId,
          payload: {
            policyId: policy.id,
            usedToday: policy.usedToday,
            dailyBudgetUnits: policy.dailyBudgetUnits,
          },
        });
        await markMonitoringPolicyQueued(policy.id);
        continue;
      }

      try {
        const authorization = await getCurrentAuthorization(policy.targetId);
        const decision = authorize({
          authorization,
          requestedCapability: policy.capability,
          requestedUrl: policy.requestedUrl,
        });
        const job = await createAuthorizedJob({
          targetId: policy.targetId,
          authorizationId: authorization.id,
          jobType: "continuous-monitor",
          capability: policy.capability,
          requestedUrl: policy.requestedUrl,
          input: {
            ...(policy.input || {}),
            monitoringPolicyId: policy.id,
          },
          decision,
          maxAttempts: 3,
        });
        await markMonitoringPolicyQueued(policy.id);
        queued.push({ policyId: policy.id, jobId: job.id });
      } catch (error) {
        skipped.push({ policyId: policy.id, reason: error.code || "AUTHORIZATION_FAILED" });
        await recordOperationalEvent({
          component: "monitoring",
          eventType: "MONITOR_QUEUE_FAILED",
          severity: "ERROR",
          targetId: policy.targetId,
          payload: { policyId: policy.id, error: error.message },
        });
        await markMonitoringPolicyQueued(policy.id);
      }
    }

    return json(res, 200, { queued, skipped, deadLettered });
  }

  match = url.pathname.match(/^\/v1\/targets\/([0-9a-f-]+)\/regressions$/i);
  if (req.method === "GET" && match) {
    return json(res, 200, { regressions: await listOpenRegressions(match[1]) });
  }

  if (req.method === "GET" && url.pathname === "/v1/repair-patterns") {
    const category = url.searchParams.get("category");
    if (!category) throw badRequest("category is required");
    return json(res, 200, {
      patterns: await lookupRepairPatterns({
        category,
        limit: url.searchParams.get("limit") || 5,
      }),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/ops/metrics") {
    return json(res, 200, await getOperationalMetrics());
  }

  return false;
}
