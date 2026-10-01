const DEFAULT_FRESH_MINUTES = 30;

export function privilegedMfaRequired(env = process.env) {
  return String(env.REQUIRE_PRIVILEGED_MFA || "").trim().toLowerCase() === "true";
}

export function verifiedEmailRequired(env = process.env) {
  return String(env.REQUIRE_VERIFIED_EMAIL || "").trim().toLowerCase() === "true";
}

export function assertVerifiedEmail(principal, { env = process.env } = {}) {
  if (!verifiedEmailRequired(env)) return true;
  if (principal?.kind !== "SESSION") return true;
  if (principal.user?.emailVerified) return true;

  const error = new Error(
    "email verification is required before this action",
  );
  error.statusCode = 403;
  error.code = "EMAIL_VERIFICATION_REQUIRED";
  throw error;
}

export function assertPrivilegedMfa(
  principal,
  {
    env = process.env,
    freshMinutes = Number(env.MFA_STEP_UP_MINUTES || DEFAULT_FRESH_MINUTES),
  } = {},
) {
  if (!privilegedMfaRequired(env)) return true;

  assertVerifiedEmail(principal, { env });

  if (principal?.kind !== "SESSION") {
    const error = new Error(
      "a human session with multi-factor authentication is required",
    );
    error.statusCode = 403;
    error.code = "MFA_SESSION_REQUIRED";
    throw error;
  }

  if (!principal.mfaEnabled) {
    const error = new Error(
      "multi-factor authentication must be enrolled before this action",
    );
    error.statusCode = 403;
    error.code = "MFA_ENROLLMENT_REQUIRED";
    throw error;
  }

  const minutes = Number.isFinite(freshMinutes)
    ? Math.min(Math.max(freshMinutes, 1), 240)
    : DEFAULT_FRESH_MINUTES;
  const verifiedAt = principal.mfaVerifiedAt
    ? new Date(principal.mfaVerifiedAt).getTime()
    : NaN;
  if (
    !Number.isFinite(verifiedAt) ||
    verifiedAt < Date.now() - minutes * 60_000
  ) {
    const error = new Error(
      "a recent multi-factor verification is required before this action",
    );
    error.statusCode = 403;
    error.code = "MFA_STEP_UP_REQUIRED";
    error.details = { freshMinutes: minutes };
    throw error;
  }

  return true;
}
