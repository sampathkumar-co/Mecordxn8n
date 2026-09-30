export const AUTHORIZATION_MODES = Object.freeze({
  PUBLIC_QA_ONLY: "PUBLIC_QA_ONLY",
  BUG_BOUNTY: "BUG_BOUNTY",
  CLIENT_AUTHORIZED: "CLIENT_AUTHORIZED",
  DO_NOT_TEST: "DO_NOT_TEST",
});

export const CAPABILITIES = Object.freeze({
  PUBLIC_HTTP_OBSERVE: "PUBLIC_HTTP_OBSERVE",
  BROWSER_QA: "BROWSER_QA",
  SITE_DISCOVERY: "SITE_DISCOVERY",
  JOURNEY_QA: "JOURNEY_QA",
  FINDING_VERIFY: "FINDING_VERIFY",
  PERFORMANCE_AUDIT: "PERFORMANCE_AUDIT",
  ACCESSIBILITY_AUDIT: "ACCESSIBILITY_AUDIT",
  SECURITY_PASSIVE: "SECURITY_PASSIVE",
  SECURITY_ACTIVE: "SECURITY_ACTIVE",
  SOURCE_REMEDIATION: "SOURCE_REMEDIATION",
});

const PUBLIC_QA_CAPABILITIES = new Set([
  CAPABILITIES.PUBLIC_HTTP_OBSERVE,
  CAPABILITIES.BROWSER_QA,
  CAPABILITIES.SITE_DISCOVERY,
  CAPABILITIES.JOURNEY_QA,
  CAPABILITIES.FINDING_VERIFY,
  CAPABILITIES.PERFORMANCE_AUDIT,
  CAPABILITIES.ACCESSIBILITY_AUDIT,
]);

export class AuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}

function normalizeHost(value) {
  return String(value || "").trim().toLowerCase().replace(/\.$/, "");
}

function requireValidUrl(value) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("unsupported protocol");
    }
    return url;
  } catch {
    throw new AuthorizationError("INVALID_URL", "requestedUrl must be a valid HTTP(S) URL");
  }
}

function isExpired(expiresAt, now) {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    throw new AuthorizationError("INVALID_EXPIRY", "authorization expiry is invalid");
  }
  return expiry.getTime() <= now.getTime();
}

/**
 * Fail-closed authorization decision used by every worker entry point.
 * Privileged modes require explicit capability grants and exact host grants.
 */
export function assertAuthorized({
  authorization,
  requestedCapability,
  requestedUrl,
  now = new Date(),
}) {
  if (!authorization) {
    throw new AuthorizationError("NO_AUTHORIZATION", "no authorization record exists");
  }

  if (!Object.values(CAPABILITIES).includes(requestedCapability)) {
    throw new AuthorizationError("UNKNOWN_CAPABILITY", "requested capability is unknown");
  }

  const url = requireValidUrl(requestedUrl);
  const host = normalizeHost(url.hostname);
  const mode = authorization.mode;

  if (!Object.values(AUTHORIZATION_MODES).includes(mode)) {
    throw new AuthorizationError("UNKNOWN_MODE", "authorization mode is unknown");
  }

  if (mode === AUTHORIZATION_MODES.DO_NOT_TEST) {
    throw new AuthorizationError("TARGET_BLOCKED", "target is marked DO_NOT_TEST");
  }

  if (isExpired(authorization.expiresAt, now)) {
    throw new AuthorizationError("AUTHORIZATION_EXPIRED", "authorization has expired");
  }

  const allowedHosts = new Set(
    (authorization.allowedHosts || []).map(normalizeHost).filter(Boolean),
  );

  if (!allowedHosts.has(host)) {
    throw new AuthorizationError(
      "HOST_OUT_OF_SCOPE",
      `host ${host} is not explicitly authorized`,
    );
  }

  if (mode === AUTHORIZATION_MODES.PUBLIC_QA_ONLY) {
    if (!PUBLIC_QA_CAPABILITIES.has(requestedCapability)) {
      throw new AuthorizationError(
        "CAPABILITY_NOT_ALLOWED",
        `${requestedCapability} is not permitted for PUBLIC_QA_ONLY`,
      );
    }

    return {
      authorized: true,
      mode,
      host,
      capability: requestedCapability,
    };
  }

  // BUG_BOUNTY and CLIENT_AUTHORIZED both require explicit capability grants.
  const allowedCapabilities = new Set(authorization.allowedCapabilities || []);
  if (!allowedCapabilities.has(requestedCapability)) {
    throw new AuthorizationError(
      "CAPABILITY_NOT_GRANTED",
      `${requestedCapability} is not explicitly granted`,
    );
  }

  if (
    requestedCapability === CAPABILITIES.SOURCE_REMEDIATION &&
    mode !== AUTHORIZATION_MODES.CLIENT_AUTHORIZED
  ) {
    throw new AuthorizationError(
      "SOURCE_ACCESS_REQUIRES_CLIENT_AUTH",
      "source remediation requires CLIENT_AUTHORIZED mode",
    );
  }

  return {
    authorized: true,
    mode,
    host,
    capability: requestedCapability,
  };
}
