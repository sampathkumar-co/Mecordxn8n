import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

process.env.PLATFORM_AUTH_KEY ||= "test-mfa-auth-key-with-at-least-32-characters";

import { createServer } from "../src/server.js";
import { closePool } from "../src/repository.js";
import { generateTotpCode } from "../src/platform/mfa.js";

const enabled = Boolean(process.env.DATABASE_URL);
const ORCHESTRATOR_TOKEN = "mfa-cookie-orchestrator";
const WORKER_TOKEN = "mfa-cookie-worker";
let server;
let baseUrl;

if (enabled) {
  server = createServer({
    orchestratorToken: ORCHESTRATOR_TOKEN,
    workerToken: WORKER_TOKEN,
    bootstrapToken: "mfa-cookie-bootstrap-secret",
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

after(async () => {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (enabled) await closePool();
});

async function raw(path, {
  method = "GET",
  body,
  cookie,
  csrf,
  sessionMode = false,
} = {}) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(sessionMode ? { "x-mecord-session-mode": "cookie" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json().catch(() => null),
    setCookie: response.headers.get("set-cookie") || "",
  };
}

function cookiePair(setCookie) {
  return String(setCookie).split(";")[0];
}

test(
  "HttpOnly cookie sessions enforce CSRF and complete the TOTP MFA lifecycle",
  { skip: !enabled },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const email = `mfa-${suffix}@example.test`;
    const password = "MFA-cookie-password-12345";

    const signup = await raw("/v1/platform/auth/signup", {
      method: "POST",
      sessionMode: true,
      body: {
        email,
        displayName: "MFA Owner",
        password,
        workspaceName: `MFA ${suffix}`,
        workspaceSlug: `mfa-${suffix}`,
      },
    });
    assert.equal(signup.status, 201);
    assert.equal(Object.hasOwn(signup.body, "token"), false);
    assert.match(signup.body.csrfToken, /^mcc_/);
    assert.match(signup.setCookie, /HttpOnly/i);
    assert.match(signup.setCookie, /SameSite=Strict/i);
    let cookie = cookiePair(signup.setCookie);
    let csrf = signup.body.csrfToken;

    const me = await raw("/v1/platform/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.principal.mfa.enabled, false);

    const csrfDenied = await raw("/v1/platform/mfa/enroll", {
      method: "POST",
      cookie,
      body: {},
    });
    assert.equal(csrfDenied.status, 403);
    assert.equal(csrfDenied.body.error, "CSRF_REQUIRED");

    const enrollment = await raw("/v1/platform/mfa/enroll", {
      method: "POST",
      cookie,
      csrf,
      body: {},
    });
    assert.equal(enrollment.status, 201);
    assert.match(enrollment.body.secret, /^[A-Z2-7]+$/);
    assert.equal(enrollment.body.recoveryCodes.length, 10);

    const code = generateTotpCode(enrollment.body.secret);
    const confirmed = await raw("/v1/platform/mfa/confirm", {
      method: "POST",
      cookie,
      csrf,
      body: { code },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.enabled, true);

    const status = await raw("/v1/platform/mfa", { cookie });
    assert.equal(status.status, 200);
    assert.equal(status.body.enabled, true);
    assert.equal(status.body.recoveryCodesRemaining, 10);
    assert.ok(status.body.sessionVerifiedAt);

    const logout = await raw("/v1/platform/auth/logout", {
      method: "POST",
      cookie,
      csrf,
      body: {},
    });
    assert.equal(logout.status, 204);

    const passwordOnly = await raw("/v1/platform/auth/login", {
      method: "POST",
      sessionMode: true,
      body: { email, password },
    });
    assert.equal(passwordOnly.status, 202);
    assert.equal(passwordOnly.body.mfaRequired, true);
    assert.equal(passwordOnly.setCookie, "");

    const mfaLogin = await raw("/v1/platform/auth/login", {
      method: "POST",
      sessionMode: true,
      body: {
        email,
        password,
        mfaCode: generateTotpCode(enrollment.body.secret),
      },
    });
    assert.equal(mfaLogin.status, 200);
    assert.equal(Object.hasOwn(mfaLogin.body, "token"), false);
    assert.match(mfaLogin.body.csrfToken, /^mcc_/);
    cookie = cookiePair(mfaLogin.setCookie);
    csrf = mfaLogin.body.csrfToken;

    const recovery = enrollment.body.recoveryCodes[0];
    const stepUp = await raw("/v1/platform/mfa/verify", {
      method: "POST",
      cookie,
      csrf,
      body: { code: recovery },
    });
    assert.equal(stepUp.status, 200);

    const afterRecovery = await raw("/v1/platform/mfa", { cookie });
    assert.equal(afterRecovery.body.recoveryCodesRemaining, 9);

    const replay = await raw("/v1/platform/mfa/verify", {
      method: "POST",
      cookie,
      csrf,
      body: { code: recovery },
    });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.error, "MFA_CODE_INVALID");

    const disabled = await raw("/v1/platform/mfa/disable", {
      method: "POST",
      cookie,
      csrf,
      body: { code: generateTotpCode(enrollment.body.secret) },
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.enabled, false);

    const finalStatus = await raw("/v1/platform/mfa", { cookie });
    assert.equal(finalStatus.status, 200);
    assert.equal(finalStatus.body.enabled, false);
  },
);
