import {
  AUTHORIZATION_MODES,
  CAPABILITIES,
  AuthorizationError,
  assertAuthorized,
} from "../authorization.js";
import {
  createAuthorizedJob,
  createTargetWithAuthorization,
  getCurrentAuthorization,
} from "../repository.js";
import {
  getFindingContext,
  getTarget,
  listOpportunityFindings,
  saveReport,
} from "../milestone-a/repository.js";
import { buildClientProposal } from "../milestone-a/report.js";
import {
  createApprovalRequest,
  createMonitoringPolicy,
  setMonitoringPolicyEnabled,
} from "../milestone-b/repository.js";
import {
  acceptWorkspaceInvite,
  accessAllows,
  beginPlatformMfaEnrollment,
  bootstrapPlatformOwner,
  confirmPlatformMfaEnrollment,
  consumePlatformRateLimit,
  createWorkspaceInvite,
  createEmailVerificationToken,
  disablePlatformMfa,
  getPlatformMfaStatus,
  getWorkspaceAccess,
  loginPlatformUser,
  requestPasswordResetToken,
  resetPasswordWithToken,
  listPlatformUserSessions,
  listWorkspaceInvites,
  revokePlatformSession,
  revokePlatformUserSession,
  verifyEmailWithToken,
  verifyPlatformMfaStepUp,
} from "./auth.js";
import {
  consumePublicRateLimit,
  hasVerifiedDomain,
} from "../milestone-h/repository.js";
import {
  clearPlatformSessionCookie,
  setPlatformSessionCookie,
} from "./session-http.js";
import { decidePlatformApproval } from "./approvals.js";
import { assertPrivilegedMfa, assertVerifiedEmail } from "./mfa-policy.js";
import { deliverAuthMail } from "./auth-mail.js";
import {
  approvalBelongsToWorkspace,
  createWorkspace,
  createWorkspaceApiKey,
  deleteWorkspace,
  getWorkspace,
  getWorkspaceFinding,
  getWorkspaceOverview,
  getWorkspaceOpportunityDetail,
  getWorkspaceSubscription,
  listUserWorkspaces,
  listWorkspaceApiKeys,
  listWorkspaceApprovals,
  listWorkspaceAudit,
  listWorkspaceFindings,
  listWorkspaceMembers,
  listWorkspaceOperations,
  listWorkspacePipeline,
  listWorkspaceReports,
  listWorkspaceTargets,
  purgeExpiredWorkspaceData,
  removeWorkspaceMember,
  revokeWorkspaceApiKey,
  targetBelongsToWorkspace,
  updateWorkspaceMemberRole,
  updateWorkspaceRetention,
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
  return (forwarded || direct).slice(0, 128);
}

function boundedString(value, max, name, badRequest, { required = false } = {}) {
  const text = String(value || "").trim();
  if (required && !text) throw badRequest(`${name} is required`);
  if (text.length > max) throw badRequest(`${name} is too long`);
  return text || null;
}

function normalizeSlug(value, badRequest) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug || slug === "system") throw badRequest("workspace slug is invalid");
  return slug;
}

function normalizeTarget(body, badRequest) {
  if (!body || typeof body !== "object") throw badRequest("body is required");
  const organizationName = boundedString(
    body.organizationName,
    240,
    "organizationName",
    badRequest,
    { required: true },
  );

  let base;
  try {
    base = new URL(body.baseUrl);
  } catch {
    throw badRequest("baseUrl must be a valid URL");
  }
  if (!["http:", "https:"].includes(base.protocol)) {
    throw badRequest("baseUrl must use HTTP(S)");
  }

  const authorization = body.authorization;
  if (!authorization || typeof authorization !== "object") {
    throw badRequest("authorization is required");
  }
  if (!Object.values(AUTHORIZATION_MODES).includes(authorization.mode)) {
    throw badRequest("authorization.mode is invalid");
  }
  if (
    ![
      AUTHORIZATION_MODES.PUBLIC_QA_ONLY,
      AUTHORIZATION_MODES.DO_NOT_TEST,
    ].includes(authorization.mode)
  ) {
    throw badRequest(
      "self-serve target registration supports PUBLIC_QA_ONLY or DO_NOT_TEST; privileged modes require a verified authorization upgrade",
    );
  }
  const allowedHosts = Array.isArray(authorization.allowedHosts)
    ? [...new Set(
        authorization.allowedHosts
          .map((item) => String(item).trim().toLowerCase())
          .filter(Boolean),
      )]
    : [];
  if (!allowedHosts.includes(base.hostname.toLowerCase())) {
    throw badRequest("baseUrl hostname must be authorized");
  }
  const allowedCapabilities = Array.isArray(authorization.allowedCapabilities)
    ? [...new Set(authorization.allowedCapabilities)]
    : [];
  if (
    authorization.mode === AUTHORIZATION_MODES.CLIENT_AUTHORIZED ||
    allowedCapabilities.includes(CAPABILITIES.SOURCE_REMEDIATION)
  ) {
    throw badRequest(
      "self-serve targets must start non-destructive; verify domain ownership before upgrading to client-authorized source remediation",
    );
  }
  for (const capability of allowedCapabilities) {
    if (!Object.values(CAPABILITIES).includes(capability)) {
      throw badRequest(`unknown capability: ${capability}`);
    }
  }
  let expiresAt = null;
  if (authorization.expiresAt) {
    const expiry = new Date(authorization.expiresAt);
    if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      throw badRequest("authorization.expiresAt must be a future date");
    }
    expiresAt = expiry.toISOString();
  }
  if (
    [AUTHORIZATION_MODES.BUG_BOUNTY, AUTHORIZATION_MODES.CLIENT_AUTHORIZED]
      .includes(authorization.mode) &&
    !expiresAt
  ) {
    throw badRequest("privileged authorization modes require expiresAt");
  }

  return {
    organizationName,
    baseUrl: base.toString(),
    authorization: {
      mode: authorization.mode,
      allowedHosts,
      allowedCapabilities,
      scopeNotes: boundedString(
        authorization.scopeNotes,
        2000,
        "scopeNotes",
        badRequest,
      ),
      evidenceReference: boundedString(
        authorization.evidenceReference,
        1000,
        "evidenceReference",
        badRequest,
      ),
      expiresAt,
    },
  };
}

function normalizeProjectRoot(value, badRequest) {
  const root = String(value || "").trim();
  if (!root || root.length > 1024) throw badRequest("projectRoot is invalid");

  const hasControl = Array.from(root).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (hasControl) throw badRequest("projectRoot contains control characters");
  if (root.includes("://")) {
    throw badRequest("projectRoot must be a local filesystem path");
  }

  const windowsAbsolute =
    root.length >= 3 &&
    /[a-z]/i.test(root[0]) &&
    root[1] === ":" &&
    (root.charCodeAt(2) === 92 || root[2] === "/");
  const posixAbsolute = root.startsWith("/");
  const normalized = root.replaceAll(String.fromCharCode(92), "/");

  if (
    (!windowsAbsolute && !posixAbsolute) ||
    normalized.split("/").includes("..")
  ) {
    throw badRequest("projectRoot must be absolute without parent traversal");
  }
  return root;
}

function authorize(args) {
  try {
    return assertAuthorized(args);
  } catch (error) {
    if (error instanceof AuthorizationError) error.statusCode = 403;
    throw error;
  }
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

async function requireTargetExecutionAuthority({
  workspaceId,
  targetId,
  authorization,
}) {
  if (authorization?.mode === AUTHORIZATION_MODES.BUG_BOUNTY) return;
  if (await hasVerifiedDomain({ workspaceId, targetId })) return;
  const error = new Error(
    "domain ownership verification or operator-validated bug-bounty authorization is required before execution",
  );
  error.statusCode = 409;
  error.code = "DOMAIN_VERIFICATION_REQUIRED";
  throw error;
}

export async function handlePlatformPublicRoute({
  req,
  res,
  url,
  json,
  readJson,
  badRequest,
  bootstrapToken,
  bearerToken,
}) {
  if (req.method === "POST" && url.pathname === "/v1/platform/bootstrap") {
    if (!bootstrapToken || bearerToken !== bootstrapToken) {
      return json(res, 401, { error: "BOOTSTRAP_UNAUTHORIZED" });
    }
    const body = await readJson(req);
    const result = await bootstrapPlatformOwner({
      email: body.email,
      displayName: body.displayName,
      password: body.password,
      workspaceName: body.workspaceName,
      workspaceSlug: body.workspaceSlug,
      userAgent: req.headers["user-agent"] || "",
    });
    setPlatformSessionCookie(res, result.token, result.expiresAt);
    return json(res, 201, browserSessionResponse(req, result));
  }

  if (req.method === "POST" && url.pathname === "/v1/platform/auth/login") {
    const body = await readJson(req);
    const remoteAddress = publicClientAddress(req);
    const emailKey = String(body.email || "").trim().toLowerCase();
    if (!(await consumePublicRateLimit({ key: "login-ip:" + remoteAddress, limit: 30 }))) {
      return json(res, 429, { error: "LOGIN_RATE_LIMITED" });
    }
    if (!(await consumePublicRateLimit({ key: "login-email:" + emailKey, limit: 8 }))) {
      return json(res, 429, { error: "LOGIN_RATE_LIMITED" });
    }
    const result = await loginPlatformUser({
      email: body.email,
      password: body.password,
      mfaCode: body.mfaCode || null,
      userAgent: req.headers["user-agent"] || "",
    });
    if (!result) return json(res, 401, { error: "INVALID_CREDENTIALS" });
    if (result.mfaRequired) {
      return json(res, 202, {
        mfaRequired: true,
        user: result.user,
      });
    }
    setPlatformSessionCookie(res, result.token, result.expiresAt);
    return json(res, 200, browserSessionResponse(req, result));
  }

  if (
    req.method === "POST" &&
    url.pathname === "/v1/platform/auth/verify-email"
  ) {
    const body = await readJson(req);
    const remoteAddress = publicClientAddress(req);
    if (!(await consumePublicRateLimit({
      key: "verify-email-ip:" + remoteAddress,
      limit: 30,
    }))) {
      return json(res, 429, { error: "VERIFY_EMAIL_RATE_LIMITED" });
    }
    const verified = await verifyEmailWithToken(body.token);
    if (!verified) {
      return json(res, 400, { error: "VERIFY_EMAIL_TOKEN_INVALID" });
    }
    return json(res, 200, { verified: true });
  }

  if (
    req.method === "POST" &&
    url.pathname === "/v1/platform/auth/password-reset/request"
  ) {
    const body = await readJson(req);
    const remoteAddress = publicClientAddress(req);
    const emailKey = String(body.email || "").trim().toLowerCase();
    if (!(await consumePublicRateLimit({
      key: "password-reset-ip:" + remoteAddress,
      limit: 20,
    }))) {
      return json(res, 429, { accepted: true });
    }
    if (!(await consumePublicRateLimit({
      key: "password-reset-email:" + emailKey,
      limit: 5,
    }))) {
      return json(res, 202, { accepted: true });
    }

    try {
      const issued = await requestPasswordResetToken(body.email);
      if (issued) {
        await deliverAuthMail({
          kind: "PASSWORD_RESET",
          email: issued.user.email,
          token: issued.token,
          expiresAt: issued.expiresAt,
        });
      }
    } catch {
      // Public responses are deliberately opaque to account existence and
      // delivery-provider state. Operators receive provider-side failures.
    }
    return json(res, 202, { accepted: true });
  }

  if (
    req.method === "POST" &&
    url.pathname === "/v1/platform/auth/password-reset/confirm"
  ) {
    const body = await readJson(req);
    const remoteAddress = publicClientAddress(req);
    if (!(await consumePublicRateLimit({
      key: "password-reset-confirm-ip:" + remoteAddress,
      limit: 20,
    }))) {
      return json(res, 429, { error: "PASSWORD_RESET_RATE_LIMITED" });
    }
    const reset = await resetPasswordWithToken({
      token: body.token,
      password: body.password,
    });
    if (!reset) {
      return json(res, 400, { error: "PASSWORD_RESET_TOKEN_INVALID" });
    }
    clearPlatformSessionCookie(res);
    return json(res, 200, { reset: true });
  }

  if (
    req.method === "POST" &&
    url.pathname === "/v1/platform/auth/accept-invite"
  ) {
    const body = await readJson(req);
    const remoteAddress = publicClientAddress(req);
    if (!(await consumePublicRateLimit({ key: "invite-ip:" + remoteAddress, limit: 20 }))) {
      return json(res, 429, { error: "INVITE_RATE_LIMITED" });
    }
    if (!(await consumePublicRateLimit({
      key: "invite-token:" + String(body.inviteToken || ""),
      limit: 5,
    }))) {
      return json(res, 429, { error: "INVITE_RATE_LIMITED" });
    }
    const result = await acceptWorkspaceInvite({
      token: body.inviteToken,
      password: body.password,
      displayName: body.displayName,
      userAgent: req.headers["user-agent"] || "",
    });
    if (!result) {
      return json(res, 401, { error: "INVALID_OR_EXPIRED_INVITE" });
    }
    setPlatformSessionCookie(res, result.token, result.expiresAt);
    return json(res, 200, browserSessionResponse(req, result));
  }

  return false;
}

export async function handlePlatformRoute({
  req,
  res,
  url,
  json,
  readJson,
  badRequest,
  principal,
}) {
  if (!(await consumePlatformRateLimit(principal))) {
    return json(res, 429, { error: "RATE_LIMIT_EXCEEDED" });
  }

  if (req.method === "GET" && url.pathname === "/v1/platform/me") {
    const workspaces =
      principal.kind === "SESSION"
        ? await listUserWorkspaces(principal.userId)
        : [await getWorkspace(principal.workspaceId)].filter(Boolean);
    return json(res, 200, {
      principal: {
        kind: principal.kind,
        user: principal.user || null,
        mfa:
          principal.kind === "SESSION"
            ? {
                enabled: Boolean(principal.mfaEnabled),
                verifiedAt: principal.mfaVerifiedAt || null,
              }
            : null,
      },
      workspaces,
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/platform/auth/logout") {
    if (principal.kind === "SESSION") {
      await revokePlatformSession(principal.id);
    }
    clearPlatformSessionCookie(res);
    return json(res, 204, {});
  }

  if (req.method === "GET" && url.pathname === "/v1/platform/sessions") {
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    return json(res, 200, {
      sessions: await listPlatformUserSessions(principal.userId),
      currentSessionId: principal.id,
    });
  }

  if (
    req.method === "POST" &&
    url.pathname === "/v1/platform/email-verification/resend"
  ) {
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const issued = await createEmailVerificationToken(principal.userId);
    if (!issued) return json(res, 204, {});
    const delivery = await deliverAuthMail({
      kind: "EMAIL_VERIFY",
      email: issued.user.email,
      token: issued.token,
      expiresAt: issued.expiresAt,
    });
    if (!delivery.delivered) {
      return json(res, 503, { error: "AUTH_MAIL_NOT_CONFIGURED" });
    }
    return json(res, 202, { accepted: true });
  }

  if (url.pathname === "/v1/platform/mfa") {
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    if (req.method === "GET") {
      const status = await getPlatformMfaStatus(principal.userId);
      return json(res, 200, {
        ...status,
        sessionVerifiedAt: principal.mfaVerifiedAt || null,
      });
    }
  }

  if (req.method === "POST" && url.pathname === "/v1/platform/mfa/enroll") {
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const enrollment = await beginPlatformMfaEnrollment({
      userId: principal.userId,
      email: principal.user?.email || "",
    });
    return json(res, 201, enrollment);
  }

  if (req.method === "POST" && url.pathname === "/v1/platform/mfa/confirm") {
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const body = await readJson(req);
    const confirmed = await confirmPlatformMfaEnrollment({
      userId: principal.userId,
      sessionId: principal.id,
      code: boundedString(body.code, 64, "code", badRequest, { required: true }),
    });
    if (!confirmed) return json(res, 400, { error: "MFA_CODE_INVALID" });
    return json(res, 200, { enabled: true });
  }

  if (req.method === "POST" && url.pathname === "/v1/platform/mfa/verify") {
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const body = await readJson(req);
    const verified = await verifyPlatformMfaStepUp({
      userId: principal.userId,
      sessionId: principal.id,
      code: boundedString(body.code, 64, "code", badRequest, { required: true }),
    });
    if (!verified) return json(res, 400, { error: "MFA_CODE_INVALID" });
    return json(res, 200, { verified: true });
  }

  if (req.method === "POST" && url.pathname === "/v1/platform/mfa/disable") {
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const body = await readJson(req);
    const disabled = await disablePlatformMfa({
      userId: principal.userId,
      sessionId: principal.id,
      code: boundedString(body.code, 64, "code", badRequest, { required: true }),
    });
    if (!disabled) return json(res, 400, { error: "MFA_CODE_INVALID" });
    return json(res, 200, { enabled: false });
  }

  let sessionMatch = url.pathname.match(
    /^\/v1\/platform\/sessions\/([0-9a-f-]+)\/revoke$/i,
  );
  if (req.method === "POST" && sessionMatch) {
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    if (sessionMatch[1] === principal.id) {
      return json(res, 409, { error: "CURRENT_SESSION_USE_LOGOUT" });
    }
    const revoked = await revokePlatformUserSession(
      principal.userId,
      sessionMatch[1],
    );
    if (!revoked) return json(res, 404, { error: "SESSION_NOT_FOUND" });
    return json(res, 204, {});
  }

  if (req.method === "GET" && url.pathname === "/v1/platform/workspaces") {
    if (principal.kind !== "SESSION") {
      return json(res, 200, {
        workspaces: [await getWorkspace(principal.workspaceId)].filter(Boolean),
      });
    }
    return json(res, 200, {
      workspaces: await listUserWorkspaces(principal.userId),
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/platform/workspaces") {
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const body = await readJson(req);
    const workspace = await createWorkspace({
      ownerUserId: principal.userId,
      name: boundedString(body.name, 160, "name", badRequest, {
        required: true,
      }),
      slug: normalizeSlug(body.slug || body.name, badRequest),
    });
    return json(res, 201, workspace);
  }

  let match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/overview$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, await getWorkspaceOverview(match[1]));
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/targets$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, {
      targets: await listWorkspaceTargets(
        match[1],
        url.searchParams.get("limit") || 100,
      ),
    });
  }
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OPERATOR",
      apiScope: "targets:write",
    });
    const input = normalizeTarget(await readJson(req), badRequest);
    const target = await createTargetWithAuthorization({
      workspaceId: match[1],
      ...input,
    });
    return json(res, 201, target);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/jobs$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OPERATOR",
      apiScope: "targets:write",
    });
    assertVerifiedEmail(principal);
    const body = await readJson(req);
    if (!validId(body.targetId)) throw badRequest("targetId is invalid");
    if (!(await targetBelongsToWorkspace(body.targetId, match[1]))) {
      return json(res, 404, { error: "TARGET_NOT_FOUND" });
    }
    if (!Object.values(CAPABILITIES).includes(body.capability)) {
      throw badRequest("capability is invalid");
    }
    if (body.capability === CAPABILITIES.SOURCE_REMEDIATION) {
      return json(res, 403, { error: "APPROVAL_REQUIRED" });
    }
    const authorization = await getCurrentAuthorization(body.targetId);
    await requireTargetExecutionAuthority({
      workspaceId: match[1],
      targetId: body.targetId,
      authorization,
    });
    const decision = authorize({
      authorization,
      requestedCapability: body.capability,
      requestedUrl: body.requestedUrl,
    });
    const job = await createAuthorizedJob({
      targetId: body.targetId,
      authorizationId: authorization.id,
      jobType: boundedString(body.jobType, 120, "jobType", badRequest, {
        required: true,
      }),
      capability: body.capability,
      requestedUrl: body.requestedUrl,
      input: body.input || {},
      maxAttempts: Math.min(Math.max(Number(body.maxAttempts) || 3, 1), 10),
      decision,
    });
    return json(res, 201, job);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/findings$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, {
      findings: await listWorkspaceFindings({
        workspaceId: match[1],
        status: url.searchParams.get("status"),
        limit: url.searchParams.get("limit") || 100,
      }),
    });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/findings\/([0-9a-f-]+)$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    const finding = await getWorkspaceFinding(match[1], match[2]);
    if (!finding) return json(res, 404, { error: "FINDING_NOT_FOUND" });
    return json(res, 200, finding);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/findings\/([0-9a-f-]+)\/remediate$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OPERATOR",
      apiScope: "approvals:write",
    });
    const finding = await getFindingContext(match[2]);
    if (
      !finding ||
      !(await targetBelongsToWorkspace(finding.targetId, match[1]))
    ) {
      return json(res, 404, { error: "FINDING_NOT_FOUND" });
    }
    if (finding.verification?.status !== "VERIFIED") {
      return json(res, 409, { error: "FINDING_NOT_VERIFIED" });
    }
    const body = await readJson(req);
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
          projectRoot: normalizeProjectRoot(body.projectRoot, badRequest),
          findingId: finding.id,
        },
        requestedBy: principal.user?.email || "api-key",
        expiresMinutes: Math.min(
          Math.max(Number(body.expiresMinutes) || 120, 5),
          1440,
        ),
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
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/targets\/([0-9a-f-]+)\/monitors$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OPERATOR",
      apiScope: "targets:write",
    });
    if (!(await targetBelongsToWorkspace(match[2], match[1]))) {
      return json(res, 404, { error: "TARGET_NOT_FOUND" });
    }
    const body = await readJson(req);
    if (
      ![CAPABILITIES.PUBLIC_HTTP_OBSERVE, CAPABILITIES.BROWSER_QA]
        .includes(body.capability)
    ) {
      throw badRequest("monitor capability is invalid");
    }
    const cadenceMinutes = Number(body.cadenceMinutes);
    if (
      !Number.isInteger(cadenceMinutes) ||
      cadenceMinutes < 5 ||
      cadenceMinutes > 10080
    ) {
      throw badRequest("cadenceMinutes must be from 5 to 10080");
    }
    const target = await getTarget(match[2]);
    const requestedUrl = body.requestedUrl || target.baseUrl;
    const authorization = await getCurrentAuthorization(target.id);
    await requireTargetExecutionAuthority({
      workspaceId: match[1],
      targetId: target.id,
      authorization,
    });
    authorize({
      authorization,
      requestedCapability: body.capability,
      requestedUrl,
    });
    const policy = await createMonitoringPolicy({
      targetId: target.id,
      name: boundedString(body.name || "Continuous QA", 160, "name", badRequest, {
        required: true,
      }),
      capability: body.capability,
      requestedUrl,
      input: body.input || {},
      cadenceMinutes,
      dailyBudgetUnits: Math.min(
        Math.max(Number(body.dailyBudgetUnits) || 100, 0.25),
        100000,
      ),
    });
    return json(res, 201, policy);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/monitors\/([0-9a-f-]+)\/(enable|disable)$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OPERATOR",
      apiScope: "targets:write",
    });
    const operations = await listWorkspaceOperations(match[1], 500);
    const monitor = operations.monitors.find((item) => item.id === match[2]);
    if (!monitor) {
      return json(res, 404, { error: "MONITOR_NOT_FOUND" });
    }
    if (match[3] === "enable") {
      const authorization = await getCurrentAuthorization(monitor.target_id);
      await requireTargetExecutionAuthority({
        workspaceId: match[1],
        targetId: monitor.target_id,
        authorization,
      });
    }
    const policy = await setMonitoringPolicyEnabled(
      match[2],
      match[3] === "enable",
    );
    return json(res, 200, policy);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/approvals$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, {
      approvals: await listWorkspaceApprovals({
        workspaceId: match[1],
        status: url.searchParams.get("status"),
        limit: url.searchParams.get("limit") || 100,
      }),
    });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/approvals\/([0-9a-f-]+)\/(approve|reject)$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "approvals:write",
    });
    assertPrivilegedMfa(principal);
    if (!(await approvalBelongsToWorkspace(match[2], match[1]))) {
      return json(res, 404, { error: "APPROVAL_NOT_FOUND" });
    }
    const body = await readJson(req);
    const result = await decidePlatformApproval({
      approvalId: match[2],
      decision: match[3] === "approve" ? "APPROVED" : "REJECTED",
      decidedBy: principal.user?.email || "api-key",
      decisionNote: boundedString(
        body.decisionNote,
        2000,
        "decisionNote",
        badRequest,
      ),
    });
    return json(res, 200, browserSessionResponse(req, result));
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/reports$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    const targetId = url.searchParams.get("targetId");
    if (targetId && !validId(targetId)) throw badRequest("targetId is invalid");
    return json(res, 200, {
      reports: await listWorkspaceReports(
        match[1],
        targetId || null,
        url.searchParams.get("limit") || 100,
      ),
    });
  }
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OPERATOR",
      apiScope: "targets:write",
    });
    const body = await readJson(req);
    if (!validId(body.targetId)) throw badRequest("targetId is invalid");
    if (!(await targetBelongsToWorkspace(body.targetId, match[1]))) {
      return json(res, 404, { error: "TARGET_NOT_FOUND" });
    }
    const target = await getTarget(body.targetId);
    const findings = await listOpportunityFindings(target.id);
    const markdown = buildClientProposal({ target, findings });
    const report = await saveReport({
      targetId: target.id,
      kind: "CLIENT_PROPOSAL",
      markdown,
      summary: {
        verifiedFindings: findings.length,
        topOpportunityScore:
          findings[0]?.intelligence?.opportunityScore || 0,
      },
    });
    return json(res, 201, report);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/pipeline$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, {
      opportunities: await listWorkspacePipeline(
        match[1],
        url.searchParams.get("limit") || 100,
      ),
    });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/opportunities\/([0-9a-f-]+)$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    const detail = await getWorkspaceOpportunityDetail(match[1], match[2]);
    if (!detail) return json(res, 404, { error: "OPPORTUNITY_NOT_FOUND" });
    return json(res, 200, detail);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/operations$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(
      res,
      200,
      await listWorkspaceOperations(
        match[1],
        url.searchParams.get("limit") || 100,
      ),
    );
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/audit$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "workspace:read",
    });
    return json(res, 200, {
      events: await listWorkspaceAudit(
        match[1],
        url.searchParams.get("limit") || 100,
      ),
    });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/members$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "members:write",
    });
    return json(res, 200, {
      members: await listWorkspaceMembers(match[1]),
    });
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/invites$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "members:write",
    });
    return json(res, 200, {
      invites: await listWorkspaceInvites(match[1]),
    });
  }
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "members:write",
    });
    assertPrivilegedMfa(principal);
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const subscription = await getWorkspaceSubscription(match[1]);
    const memberLimit = subscription.limits.members;
    if (
      memberLimit != null &&
      Number(subscription.counts.members) >= memberLimit
    ) {
      return json(res, 409, { error: "PLAN_MEMBER_LIMIT" });
    }
    const body = await readJson(req);
    const invite = await createWorkspaceInvite({
      workspaceId: match[1],
      createdBy: principal.userId,
      email: body.email,
      role: String(body.role || "").toUpperCase(),
    });
    return json(res, 201, invite);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/members\/([0-9a-f-]+)\/role$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OWNER",
      apiScope: "members:write",
    });
    assertPrivilegedMfa(principal);
    const body = await readJson(req);
    const role = String(body.role || "").toUpperCase();
    if (!["ADMIN", "OPERATOR", "VIEWER"].includes(role)) {
      throw badRequest("role is invalid");
    }
    const updated = await updateWorkspaceMemberRole({
      workspaceId: match[1],
      userId: match[2],
      role,
    });
    if (!updated) return json(res, 404, { error: "MEMBER_NOT_FOUND" });
    return json(res, 200, updated);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/members\/([0-9a-f-]+)$/i,
  );
  if (req.method === "DELETE" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OWNER",
      apiScope: "members:write",
    });
    assertPrivilegedMfa(principal);
    const removed = await removeWorkspaceMember({
      workspaceId: match[1],
      userId: match[2],
    });
    if (!removed) return json(res, 404, { error: "MEMBER_NOT_FOUND" });
    return json(res, 204, {});
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/api-keys$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "members:write",
    });
    return json(res, 200, {
      apiKeys: await listWorkspaceApiKeys(match[1]),
    });
  }
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "members:write",
    });
    assertPrivilegedMfa(principal);
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const body = await readJson(req);
    const allowedScopes = new Set([
      "workspace:read",
      "targets:write",
      "approvals:write",
      "members:write",
      "integrations:write",
    ]);
    const scopes = Array.isArray(body.scopes)
      ? [...new Set(body.scopes)]
      : ["workspace:read"];
    if (scopes.some((scope) => !allowedScopes.has(scope))) {
      throw badRequest("API key scope is invalid");
    }
    const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (
      expiresAt &&
      (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())
    ) {
      throw badRequest("expiresAt must be in the future");
    }
    const created = await createWorkspaceApiKey({
      workspaceId: match[1],
      createdBy: principal.userId,
      name: boundedString(body.name, 120, "name", badRequest, {
        required: true,
      }),
      scopes,
      rateLimitPerHour: Math.min(
        Math.max(Number(body.rateLimitPerHour) || 2000, 60),
        100000,
      ),
      expiresAt: expiresAt?.toISOString() || null,
    });
    return json(res, 201, created);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/api-keys\/([0-9a-f-]+)\/revoke$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "members:write",
    });
    assertPrivilegedMfa(principal);
    const revoked = await revokeWorkspaceApiKey(match[1], match[2]);
    if (!revoked) return json(res, 404, { error: "API_KEY_NOT_FOUND" });
    return json(res, 204, {});
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/subscription$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    const subscription = await getWorkspaceSubscription(match[1]);
    if (!subscription) return json(res, 404, { error: "WORKSPACE_NOT_FOUND" });
    return json(res, 200, subscription);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/retention$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OWNER",
      apiScope: "members:write",
    });
    assertPrivilegedMfa(principal);
    const body = await readJson(req);
    const retentionDays = Number(body.retentionDays);
    if (
      !Number.isInteger(retentionDays) ||
      retentionDays < 7 ||
      retentionDays > 3650
    ) {
      throw badRequest("retentionDays must be from 7 to 3650");
    }
    return json(
      res,
      200,
      await updateWorkspaceRetention(match[1], retentionDays),
    );
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)$/i,
  );
  if (req.method === "DELETE" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "OWNER",
      apiScope: "members:write",
    });
    assertPrivilegedMfa(principal);
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const body = await readJson(req);
    const deleted = await deleteWorkspace({
      workspaceId: match[1],
      ownerUserId: principal.userId,
      confirmationSlug: String(body.confirmationSlug || ""),
    });
    if (!deleted) return json(res, 404, { error: "WORKSPACE_NOT_FOUND" });
    return json(res, 204, {});
  }

  return false;
}

export async function runPlatformMaintenance() {
  return {
    purgedAuditEvents: await purgeExpiredWorkspaceData(),
  };
}
