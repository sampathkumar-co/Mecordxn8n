import { assertPrivilegedMfa } from "../platform/mfa-policy.js";
import {
  AUTHORIZATION_MODES,
  CAPABILITIES,
  AuthorizationError,
  assertAuthorized,
} from "../authorization.js";
import {
  createAuthorizedJob,
  getCurrentAuthorization,
} from "../repository.js";
import {
  getTarget,
  listOpportunityFindings,
  saveReport,
} from "../milestone-a/repository.js";
import { createApprovalRequest } from "../milestone-b/repository.js";
import { buildClientProposal } from "../milestone-a/report.js";
import {
  registerSelfServeOwner,
  accessAllows,
  getWorkspaceAccess,
} from "../platform/auth.js";
import { getWorkspaceSubscription } from "../platform/repository.js";
import { applyStripeSubscriptionEvent } from "../integrations/repository.js";
import {
  createStripeCheckout,
  createStripePortal,
  verifyStripeSignature,
} from "./billing.js";
import { verifyDnsTxtOwnership } from "./domain.js";
import { setPlatformSessionCookie } from "../platform/session-http.js";
import {
  completeBillingCheckout,
  completeDomainVerification,
  consumePublicRateLimit,
  createDomainVerification,
  createReportShareLink,
  getDomainVerification,
  getPlatformOperatorOverview,
  getPublicSharedReport,
  getWorkspaceLaunchHealth,
  getWorkspaceOnboarding,
  hasVerifiedDomain,
  blockFailedOnboardingAssessments,
  claimOnboardingReadyForReport,
  failOnboardingFinalization,
  listTargetAuthorizationCenter,
  markOnboardingStep,
  recordBillingCheckout,
  reconcileBillingInvoice,
  purgePublicRateLimits,
  reportBelongsToWorkspace,
  replaceTargetAuthorization,
  revokeReportShareLink,
  revokeTargetAuthorization,
  setOnboardingAssessmentJobs,
  setOnboardingReport,
} from "./repository.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validId(value) {
  return UUID_RE.test(String(value || ""));
}

function browserSessionResponse(req, result) {
  if (String(req.headers["x-mecord-session-mode"] || "").toLowerCase() !== "cookie") {
    return result;
  }
  const { token: _token, ...safe } = result;
  return safe;
}

function publicClientAddress(req) {
  const direct = String(req.socket?.remoteAddress || "unknown").trim();
  if (String(process.env.TRUST_PROXY_HEADERS || "").toLowerCase() !== "true") {
    return direct;
  }
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  if (!forwarded) return direct;
  return forwarded.slice(0, 128);
}

function boundedString(value, max, name, badRequest, { required = false } = {}) {
  const text = String(value || "").trim();
  if (required && !text) throw badRequest(name + " is required");
  if (text.length > max) throw badRequest(name + " is too long");
  return text || null;
}

async function requireWorkspace(principal, workspaceId, rule = {}) {
  if (!validId(workspaceId)) {
    const error = new Error("workspace id is invalid");
    error.statusCode = 400;
    error.code = "INVALID_WORKSPACE_ID";
    throw error;
  }
  const access = await getWorkspaceAccess(principal, workspaceId);
  if (!access || !accessAllows(access, rule)) {
    const error = new Error("workspace access denied");
    error.statusCode = 403;
    error.code = "WORKSPACE_ACCESS_DENIED";
    throw error;
  }
  return access;
}

function normalizeAuthorizationUpdate(body, target, badRequest) {
  const mode = String(body.mode || "").trim().toUpperCase();
  if (!Object.values(AUTHORIZATION_MODES).includes(mode)) {
    throw badRequest("authorization mode is invalid");
  }
  const baseHost = new URL(target.base_url).hostname.toLowerCase();
  const allowedHosts = Array.isArray(body.allowedHosts)
    ? [...new Set(body.allowedHosts.map((item) => String(item).trim().toLowerCase()).filter(Boolean))]
    : [baseHost];
  if (!allowedHosts.includes(baseHost)) {
    throw badRequest("target hostname must remain in allowedHosts");
  }
  const allowedCapabilities = Array.isArray(body.allowedCapabilities)
    ? [...new Set(body.allowedCapabilities.map((item) => String(item).trim()))]
    : [];
  for (const capability of allowedCapabilities) {
    if (!Object.values(CAPABILITIES).includes(capability)) {
      throw badRequest("unknown capability: " + capability);
    }
  }
  if (
    allowedCapabilities.includes(CAPABILITIES.SOURCE_REMEDIATION) &&
    mode !== AUTHORIZATION_MODES.CLIENT_AUTHORIZED
  ) {
    throw badRequest("source remediation requires CLIENT_AUTHORIZED mode");
  }
  let expiresAt = null;
  if (body.expiresAt) {
    const expiry = new Date(body.expiresAt);
    if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      throw badRequest("expiresAt must be a future date");
    }
    expiresAt = expiry.toISOString();
  }
  if (
    [AUTHORIZATION_MODES.BUG_BOUNTY, AUTHORIZATION_MODES.CLIENT_AUTHORIZED].includes(mode) &&
    !expiresAt
  ) {
    throw badRequest("privileged authorization modes require expiresAt");
  }
  return {
    mode,
    allowedHosts,
    allowedCapabilities,
    scopeNotes: boundedString(body.scopeNotes, 2000, "scopeNotes", badRequest),
    evidenceReference: boundedString(
      body.evidenceReference,
      1000,
      "evidenceReference",
      badRequest,
    ),
    expiresAt,
  };
}

function authorize(args) {
  try {
    return assertAuthorized(args);
  } catch (error) {
    if (error instanceof AuthorizationError) error.statusCode = 403;
    throw error;
  }
}

export async function handleMilestoneHPublicRoute({
  req,
  res,
  url,
  json,
  readJson,
  readRaw,
  badRequest,
}) {
  if (req.method === "POST" && url.pathname === "/v1/platform/auth/signup") {
    const remoteAddress = publicClientAddress(req);
    if (!(await consumePublicRateLimit({ key: "signup-ip:" + remoteAddress, limit: 10 }))) {
      return json(res, 429, { error: "SIGNUP_RATE_LIMITED" });
    }
    const body = await readJson(req);
    const emailKey = String(body.email || "").trim().toLowerCase();
    if (!(await consumePublicRateLimit({ key: "signup-email:" + emailKey, limit: 3 }))) {
      return json(res, 429, { error: "SIGNUP_RATE_LIMITED" });
    }
    try {
      const result = await registerSelfServeOwner({
        email: body.email,
        displayName: body.displayName,
        password: body.password,
        workspaceName: body.workspaceName,
        workspaceSlug: body.workspaceSlug || body.workspaceName,
        userAgent: req.headers["user-agent"] || "",
      });
      setPlatformSessionCookie(res, result.token, result.expiresAt);
      return json(res, 201, browserSessionResponse(req, result));
    } catch (error) {
      if (error.code === "23505" || error.code === "ACCOUNT_EXISTS") {
        return json(res, 409, { error: "SIGNUP_CONFLICT" });
      }
      throw error;
    }
  }

  const shareMatch = url.pathname.match(
    /^\/v1\/platform\/public\/reports\/([A-Za-z0-9_-]+)$/i,
  );
  if (req.method === "GET" && shareMatch) {
    const report = await getPublicSharedReport(shareMatch[1]);
    if (!report) return json(res, 404, { error: "SHARE_NOT_FOUND_OR_EXPIRED" });
    return json(res, 200, report);
  }

  if (
    req.method === "POST" &&
    url.pathname === "/v1/platform/billing/stripe-webhook"
  ) {
    const raw = await readRaw(req, 512 * 1024);
    if (
      !verifyStripeSignature({
        rawBody: raw,
        signatureHeader: req.headers["stripe-signature"] || "",
      })
    ) {
      return json(res, 401, { error: "WEBHOOK_SIGNATURE_INVALID" });
    }
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(res, 400, { error: "INVALID_JSON" });
    }
    const object = event?.data?.object || {};
    if (event.type === "checkout.session.completed") {
      const completed = await completeBillingCheckout({
        providerSessionId: object.id,
        providerCustomerId: object.customer || null,
        providerSubscriptionId: object.subscription || null,
      });
      if (!completed) {
        return json(res, 202, { accepted: true, matched: false });
      }
    } else if (
      [
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
      ].includes(event.type)
    ) {
      const workspaceId =
        object.metadata?.workspace_id ||
        object.metadata?.mecord_workspace_id ||
        null;
      if (workspaceId && validId(workspaceId)) {
        await applyStripeSubscriptionEvent({
          workspaceId,
          eventType: event.type,
          subscription: object,
        });
      }
    } else if (
      ["invoice.payment_failed", "invoice.payment_succeeded"].includes(event.type)
    ) {
      await reconcileBillingInvoice({
        customerId: object.customer ? String(object.customer) : null,
        subscriptionId: object.subscription ? String(object.subscription) : null,
        paid: event.type === "invoice.payment_succeeded",
      });
    }
    return json(res, 202, { accepted: true });
  }

  return false;
}

export async function handleMilestoneHPlatformRoute({
  req,
  res,
  url,
  json,
  readJson,
  badRequest,
  principal,
}) {
  let match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/onboarding$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, await getWorkspaceOnboarding(match[1]));
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/targets\/([0-9a-f-]+)\/domain-verification$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "targets:write",
    });
    assertPrivilegedMfa(principal);
    const center = await listTargetAuthorizationCenter({
      workspaceId: match[1],
      targetId: match[2],
    });
    if (!center) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    const hostname = new URL(center.target.base_url).hostname.toLowerCase();
    const verification = await createDomainVerification({
      workspaceId: match[1],
      targetId: match[2],
      hostname,
    });
    return json(res, 201, {
      id: verification.id,
      hostname,
      method: verification.method,
      challenge: verification.challenge,
      dnsName: "_mecordxn8n." + hostname,
      expiresAt: verification.expires_at,
    });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/domain-verifications\/([0-9a-f-]+)\/verify$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "targets:write",
    });
    const verification = await getDomainVerification({
      workspaceId: match[1],
      verificationId: match[2],
    });
    if (!verification) return json(res, 404, { error: "VERIFICATION_NOT_FOUND" });
    if (verification.status !== "PENDING") {
      return json(res, 200, verification);
    }
    if (new Date(verification.expires_at).getTime() <= Date.now()) {
      const expired = await completeDomainVerification({
        workspaceId: match[1],
        verificationId: match[2],
        matched: false,
        errorCode: "CHALLENGE_EXPIRED",
      });
      return json(res, 409, { error: "CHALLENGE_EXPIRED", verification: expired });
    }
    let matched = false;
    let errorCode = null;
    try {
      matched = await verifyDnsTxtOwnership({
        hostname: "_mecordxn8n." + verification.hostname,
        challenge: verification.challenge,
      });
      if (!matched) errorCode = "DNS_TXT_NOT_FOUND";
    } catch (error) {
      errorCode = String(error?.code || "DNS_LOOKUP_FAILED").slice(0, 120);
    }
    const updated = await completeDomainVerification({
      workspaceId: match[1],
      verificationId: match[2],
      matched,
      errorCode,
    });
    return json(res, matched ? 200 : 409, {
      verified: matched,
      verification: updated,
      ...(matched ? {} : { error: errorCode }),
    });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/targets\/([0-9a-f-]+)\/authorization-center$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    const center = await listTargetAuthorizationCenter({
      workspaceId: match[1],
      targetId: match[2],
    });
    if (!center) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    return json(res, 200, center);
  }

  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "targets:write",
    });
    const center = await listTargetAuthorizationCenter({
      workspaceId: match[1],
      targetId: match[2],
    });
    if (!center) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    const body = await readJson(req);
    const normalized = normalizeAuthorizationUpdate(body, center.target, badRequest);
    if (normalized.mode === AUTHORIZATION_MODES.BUG_BOUNTY) {
      if (!principal.user?.isPlatformOperator) {
        return json(res, 403, { error: "OPERATOR_VERIFICATION_REQUIRED" });
      }
      if (!normalized.evidenceReference || !normalized.expiresAt) {
        return json(res, 400, { error: "BUG_BOUNTY_EVIDENCE_REQUIRED" });
      }
    }
    const privileged =
      normalized.mode === AUTHORIZATION_MODES.CLIENT_AUTHORIZED ||
      normalized.allowedCapabilities.includes(CAPABILITIES.SOURCE_REMEDIATION);
    if (
      privileged &&
      !(await hasVerifiedDomain({
        workspaceId: match[1],
        targetId: match[2],
      }))
    ) {
      return json(res, 409, { error: "DOMAIN_VERIFICATION_REQUIRED" });
    }
    const authorization = await replaceTargetAuthorization({
      workspaceId: match[1],
      targetId: match[2],
      ...normalized,
      actorUserId: principal.userId || null,
    });
    return json(res, 200, authorization);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/targets\/([0-9a-f-]+)\/authorization\/revoke$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "targets:write",
    });
    assertPrivilegedMfa(principal);
    const revoked = await revokeTargetAuthorization({
      workspaceId: match[1],
      targetId: match[2],
      actorUserId: principal.userId || null,
    });
    if (!revoked) return json(res, 404, { error: "ACTIVE_AUTHORIZATION_NOT_FOUND" });
    return json(res, 200, { revoked: true });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/targets\/([0-9a-f-]+)\/assess$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OPERATOR",
      apiScope: "targets:write",
    });
    const center = await listTargetAuthorizationCenter({
      workspaceId: match[1],
      targetId: match[2],
    });
    if (!center) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    const authorization = await getCurrentAuthorization(match[2]);
    if (!authorization) return json(res, 409, { error: "AUTHORIZATION_REQUIRED" });
    if (
      authorization.mode !== AUTHORIZATION_MODES.BUG_BOUNTY &&
      !(await hasVerifiedDomain({
        workspaceId: match[1],
        targetId: match[2],
      }))
    ) {
      return json(res, 409, { error: "DOMAIN_VERIFICATION_REQUIRED" });
    }
    const urlToTest = center.target.base_url;
    const jobs = {};
    if (authorization.allowedCapabilities.includes(CAPABILITIES.PUBLIC_HTTP_OBSERVE)) {
      const decision = authorize({
        authorization,
        requestedCapability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
        requestedUrl: urlToTest,
      });
      jobs.http = await createAuthorizedJob({
        targetId: match[2],
        authorizationId: authorization.id,
        jobType: "first-assessment-http",
        capability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
        requestedUrl: urlToTest,
        input: { onboarding: true },
        maxAttempts: 3,
        decision,
      });
    }
    if (authorization.allowedCapabilities.includes(CAPABILITIES.BROWSER_QA)) {
      const decision = authorize({
        authorization,
        requestedCapability: CAPABILITIES.BROWSER_QA,
        requestedUrl: urlToTest,
      });
      jobs.browser = await createAuthorizedJob({
        targetId: match[2],
        authorizationId: authorization.id,
        jobType: "first-assessment-browser",
        capability: CAPABILITIES.BROWSER_QA,
        requestedUrl: urlToTest,
        input: { onboarding: true },
        maxAttempts: 3,
        decision,
      });
    }
    if (!jobs.http && !jobs.browser) {
      return json(res, 409, { error: "NO_NON_DESTRUCTIVE_CAPABILITY_AUTHORIZED" });
    }
    await setOnboardingAssessmentJobs({
      workspaceId: match[1],
      targetId: match[2],
      httpJobId: jobs.http?.id || null,
      browserJobId: jobs.browser?.id || null,
    });
    return json(res, 202, { queued: true, jobs });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/reports\/([0-9a-f-]+)\/request-release$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "approvals:write",
    });
    const report = await reportBelongsToWorkspace({
      workspaceId: match[1],
      reportId: match[2],
    });
    if (!report) return json(res, 404, { error: "REPORT_NOT_FOUND" });
    if (report.status === "APPROVED") {
      return json(res, 200, { alreadyApproved: true, report });
    }
    try {
      const approval = await createApprovalRequest({
        targetId: report.target_id,
        reportId: report.id,
        actionType: "REPORT_RELEASE",
        payload: { reportId: report.id },
        requestedBy: principal.user?.email || "api-key",
        expiresMinutes: 120,
      });
      return json(res, 202, { approvalRequired: true, approval });
    } catch (error) {
      if (error.code === "23505") {
        return json(res, 409, { error: "APPROVAL_ALREADY_PENDING" });
      }
      throw error;
    }
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/reports\/([0-9a-f-]+)\/share$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "approvals:write",
    });
    assertPrivilegedMfa(principal);
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const body = await readJson(req);
    const expiresHours = Math.min(
      Math.max(Number(body.expiresHours) || 72, 1),
      720,
    );
    const result = await createReportShareLink({
      workspaceId: match[1],
      reportId: match[2],
      createdBy: principal.userId,
      expiresHours,
    });
    if (result.status === "NOT_FOUND") {
      return json(res, 404, { error: "REPORT_NOT_FOUND" });
    }
    if (result.status === "REPORT_NOT_APPROVED") {
      return json(res, 409, { error: "REPORT_RELEASE_REQUIRED" });
    }
    const appUrl = String(process.env.PUBLIC_APP_URL || "").replace(/\/+$/, "");
    return json(res, 201, {
      share: result.share,
      token: result.token,
      url: appUrl
        ? appUrl + "/v1/platform/public/reports/" + encodeURIComponent(result.token)
        : null,
    });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/report-shares\/([0-9a-f-]+)\/revoke$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "approvals:write",
    });
    const revoked = await revokeReportShareLink({
      workspaceId: match[1],
      shareId: match[2],
    });
    if (!revoked) return json(res, 404, { error: "REPORT_SHARE_NOT_FOUND" });
    return json(res, 200, { revoked: true });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/health$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, await getWorkspaceLaunchHealth(match[1]));
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/billing\/checkout$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OWNER",
      apiScope: "billing:write",
    });
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const body = await readJson(req);
    const plan = String(body.plan || "").trim().toUpperCase();
    if (!["TEAM", "BUSINESS", "ENTERPRISE"].includes(plan)) {
      throw badRequest("billing plan is invalid");
    }
    const subscription = await getWorkspaceSubscription(match[1]);
    if (!subscription) return json(res, 404, { error: "WORKSPACE_NOT_FOUND" });
    const session = await createStripeCheckout({
      workspaceId: match[1],
      plan,
      customerEmail: principal.user?.email || null,
      customerId: subscription.subscription?.external_customer_id || null,
    });
    await recordBillingCheckout({
      workspaceId: match[1],
      plan,
      providerSessionId: session.id,
      providerCustomerId: session.customerId,
      checkoutUrl: session.url,
      expiresAt: session.expiresAt,
      createdBy: principal.userId,
    });
    return json(res, 201, session);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/billing\/portal$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OWNER",
      apiScope: "billing:write",
    });
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const subscription = await getWorkspaceSubscription(match[1]);
    if (!subscription) return json(res, 404, { error: "WORKSPACE_NOT_FOUND" });
    return json(
      res,
      201,
      await createStripePortal({
        customerId: subscription.subscription?.external_customer_id || null,
      }),
    );
  }

  if (req.method === "GET" && url.pathname === "/v1/platform/admin/overview") {
    if (
      principal.kind !== "SESSION" ||
      !principal.user?.isPlatformOperator
    ) {
      return json(res, 403, { error: "PLATFORM_OPERATOR_REQUIRED" });
    }
    return json(
      res,
      200,
      await getPlatformOperatorOverview(url.searchParams.get("limit") || 100),
    );
  }

  return false;
}

export async function runMilestoneHMaintenance(limit = 25) {
  await purgePublicRateLimits();
  const blockedAssessments = await blockFailedOnboardingAssessments(limit);
  const candidates = await claimOnboardingReadyForReport(limit);
  const results = [];
  const failures = [];
  for (const candidate of candidates) {
    try {
      const target = await getTarget(candidate.primary_target_id);
      if (!target) throw Object.assign(new Error("target missing"), { code: "TARGET_MISSING" });
      const findings = await listOpportunityFindings(target.id);
      const proposalMarkdown = buildClientProposal({ target, findings });
      const report = await saveReport({
        targetId: target.id,
        kind: "CLIENT_PROPOSAL",
        markdown: proposalMarkdown,
        summary: {
          source: "milestone-h-onboarding",
          verifiedFindings: findings.filter(
            (item) => item.verification?.status === "VERIFIED",
          ).length,
        },
      });
      await setOnboardingReport({
        workspaceId: candidate.workspace_id,
        reportId: report.id,
      });
      results.push({
        workspaceId: candidate.workspace_id,
        targetId: target.id,
        reportId: report.id,
      });
    } catch (error) {
      const code = String(error?.code || "FINALIZATION_FAILED").slice(0, 120);
      await failOnboardingFinalization({
        workspaceId: candidate.workspace_id,
        errorCode: code,
      });
      failures.push({ workspaceId: candidate.workspace_id, code });
    }
  }
  return {
    blockedAssessments,
    claimed: candidates.length,
    finalized: results.length,
    failed: failures.length,
    reports: results,
    failures,
  };
}
