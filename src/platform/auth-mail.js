import {
  createHmac,
  randomUUID,
} from "node:crypto";

function normalizeConfig(env = process.env) {
  const endpoint = String(env.AUTH_MAIL_WEBHOOK_URL || "").trim();
  const secret = String(env.AUTH_MAIL_WEBHOOK_SECRET || "").trim();
  const publicUrl = String(env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");

  if (!endpoint || !secret || !publicUrl) {
    return { configured: false };
  }
  let url;
  let app;
  try {
    url = new URL(endpoint);
    app = new URL(publicUrl);
  } catch {
    throw new Error("auth mail URLs are invalid");
  }
  const localHttp =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("AUTH_MAIL_WEBHOOK_URL must use HTTPS");
  }
  if (app.protocol !== "https:" && process.env.NODE_ENV === "production") {
    throw new Error("PUBLIC_APP_URL must use HTTPS");
  }
  if (secret.length < 32) {
    throw new Error("AUTH_MAIL_WEBHOOK_SECRET must be at least 32 characters");
  }
  return { configured: true, endpoint: url, secret, publicUrl };
}

export function authMailConfigured(env = process.env) {
  return Boolean(normalizeConfig(env).configured);
}

export async function deliverAuthMail({
  kind,
  email,
  token,
  expiresAt,
  env = process.env,
  fetchImpl = fetch,
}) {
  const config = normalizeConfig(env);
  if (!config.configured) return { configured: false, delivered: false };

  if (!["EMAIL_VERIFY", "PASSWORD_RESET"].includes(kind)) {
    throw new Error("unsupported auth mail kind");
  }
  const parameter = kind === "EMAIL_VERIFY" ? "verify_email" : "reset_password";
  const actionUrl =
    config.publicUrl + "/console?" + parameter + "=" + encodeURIComponent(token);
  const payload = {
    id: randomUUID(),
    kind,
    to: String(email || "").trim().toLowerCase(),
    actionUrl,
    expiresAt,
  };
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", config.secret)
    .update(body)
    .digest("hex");

  const response = await fetchImpl(config.endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-mecord-signature": "sha256=" + signature,
      "x-mecord-event-id": payload.id,
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = new Error("authentication email delivery failed");
    error.code = "AUTH_MAIL_DELIVERY_FAILED";
    error.statusCode = 503;
    throw error;
  }
  return { configured: true, delivered: true };
}
