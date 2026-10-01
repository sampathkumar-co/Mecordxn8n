import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";

process.env.PLATFORM_AUTH_KEY ||= "recovery-auth-key-with-at-least-32-characters";

import { createServer } from "../src/server.js";
import { closePool } from "../src/repository.js";

const enabled = Boolean(process.env.DATABASE_URL);
const mailSecret = "recovery-mail-webhook-secret-with-at-least-32-chars";
const deliveries = [];
let mailServer;
let appServer;
let baseUrl;

if (enabled) {
  mailServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const signature = createHmac("sha256", mailSecret)
      .update(raw)
      .digest("hex");
    assert.equal(
      req.headers["x-mecord-signature"],
      "sha256=" + signature,
    );
    deliveries.push(JSON.parse(raw));
    res.writeHead(204).end();
  });
  await new Promise((resolve) => mailServer.listen(0, "127.0.0.1", resolve));
  process.env.AUTH_MAIL_WEBHOOK_URL =
    `http://127.0.0.1:${mailServer.address().port}/auth-mail`;
  process.env.AUTH_MAIL_WEBHOOK_SECRET = mailSecret;
  process.env.PUBLIC_APP_URL = "https://app.example.test";

  appServer = createServer({
    orchestratorToken: "recovery-orchestrator",
    workerToken: "recovery-worker",
    bootstrapToken: "recovery-bootstrap",
  });
  await new Promise((resolve) => appServer.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
}

after(async () => {
  if (appServer) {
    await new Promise((resolve, reject) =>
      appServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (mailServer) {
    await new Promise((resolve, reject) =>
      mailServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  delete process.env.AUTH_MAIL_WEBHOOK_URL;
  delete process.env.AUTH_MAIL_WEBHOOK_SECRET;
  if (enabled) await closePool();
});

async function request(path, {
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

function tokenFromAction(delivery, parameter) {
  const url = new URL(delivery.actionUrl);
  return url.searchParams.get(parameter);
}

test(
  "self-serve email verification and password recovery are signed, opaque, one-time and session-revoking",
  { skip: !enabled },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const email = `recovery-${suffix}@example.test`;
    const password = "Recovery-password-12345";
    const newPassword = "Recovery-new-password-67890";

    const signup = await request("/v1/platform/auth/signup", {
      method: "POST",
      sessionMode: true,
      body: {
        email,
        displayName: "Recovery Owner",
        password,
        workspaceName: `Recovery ${suffix}`,
        workspaceSlug: `recovery-${suffix}`,
      },
    });
    assert.equal(signup.status, 201);
    assert.equal(signup.body.user.emailVerified, false);
    assert.deepEqual(signup.body.emailVerification, {
      required: true,
      delivered: true,
    });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].kind, "EMAIL_VERIFY");
    assert.equal(deliveries[0].to, email);
    const verificationToken = tokenFromAction(deliveries[0], "verify_email");
    assert.match(verificationToken, /^mcv_/);

    let cookie = cookiePair(signup.setCookie);
    const csrf = signup.body.csrfToken;

    const verified = await request("/v1/platform/auth/verify-email", {
      method: "POST",
      body: { token: verificationToken },
    });
    assert.equal(verified.status, 200);

    const replayVerification = await request("/v1/platform/auth/verify-email", {
      method: "POST",
      body: { token: verificationToken },
    });
    assert.equal(replayVerification.status, 400);

    const me = await request("/v1/platform/me", { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.body.principal.user.emailVerified, true);

    const beforeUnknown = deliveries.length;
    const unknown = await request("/v1/platform/auth/password-reset/request", {
      method: "POST",
      body: { email: `unknown-${suffix}@example.test` },
    });
    assert.equal(unknown.status, 202);
    assert.deepEqual(unknown.body, { accepted: true });
    assert.equal(deliveries.length, beforeUnknown);

    const resetRequest = await request(
      "/v1/platform/auth/password-reset/request",
      { method: "POST", body: { email } },
    );
    assert.equal(resetRequest.status, 202);
    assert.deepEqual(resetRequest.body, { accepted: true });
    assert.equal(deliveries.length, beforeUnknown + 1);
    const resetDelivery = deliveries.at(-1);
    assert.equal(resetDelivery.kind, "PASSWORD_RESET");
    const resetToken = tokenFromAction(resetDelivery, "reset_password");
    assert.match(resetToken, /^mpr_/);

    const reset = await request("/v1/platform/auth/password-reset/confirm", {
      method: "POST",
      body: { token: resetToken, password: newPassword },
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.reset, true);

    const oldSession = await request("/v1/platform/me", { cookie });
    assert.equal(oldSession.status, 401);

    const resetReplay = await request(
      "/v1/platform/auth/password-reset/confirm",
      { method: "POST", body: { token: resetToken, password: newPassword } },
    );
    assert.equal(resetReplay.status, 400);

    const oldLogin = await request("/v1/platform/auth/login", {
      method: "POST",
      sessionMode: true,
      body: { email, password },
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await request("/v1/platform/auth/login", {
      method: "POST",
      sessionMode: true,
      body: { email, password: newPassword },
    });
    assert.equal(newLogin.status, 200);
    assert.equal(newLogin.body.user.emailVerified, true);
    cookie = cookiePair(newLogin.setCookie);

    const resendVerified = await request(
      "/v1/platform/email-verification/resend",
      {
        method: "POST",
        cookie,
        csrf: newLogin.body.csrfToken,
        body: {},
      },
    );
    assert.equal(resendVerified.status, 204);
  },
);
