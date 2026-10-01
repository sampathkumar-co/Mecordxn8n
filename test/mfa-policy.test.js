import test from "node:test";
import assert from "node:assert/strict";

import {
  assertPrivilegedMfa,
  privilegedMfaRequired,
} from "../src/platform/mfa-policy.js";

test("privileged MFA policy is opt-in outside production contract", () => {
  assert.equal(privilegedMfaRequired({}), false);
  assert.equal(assertPrivilegedMfa(null, { env: {} }), true);
});

test("privileged MFA policy rejects API keys, missing enrollment and stale step-up", () => {
  const env = {
    REQUIRE_PRIVILEGED_MFA: "true",
    MFA_STEP_UP_MINUTES: "30",
  };

  assert.throws(
    () => assertPrivilegedMfa({ kind: "API_KEY" }, { env }),
    (error) => error.code === "MFA_SESSION_REQUIRED" && error.statusCode === 403,
  );
  assert.throws(
    () =>
      assertPrivilegedMfa(
        { kind: "SESSION", mfaEnabled: false, mfaVerifiedAt: null },
        { env },
      ),
    (error) =>
      error.code === "MFA_ENROLLMENT_REQUIRED" && error.statusCode === 403,
  );
  assert.throws(
    () =>
      assertPrivilegedMfa(
        {
          kind: "SESSION",
          mfaEnabled: true,
          mfaVerifiedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
        },
        { env },
      ),
    (error) => error.code === "MFA_STEP_UP_REQUIRED" && error.statusCode === 403,
  );
});

test("privileged MFA policy accepts a recently verified human session", () => {
  const env = {
    REQUIRE_PRIVILEGED_MFA: "true",
    MFA_STEP_UP_MINUTES: "30",
  };
  assert.equal(
    assertPrivilegedMfa(
      {
        kind: "SESSION",
        mfaEnabled: true,
        mfaVerifiedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      { env },
    ),
    true,
  );
});
