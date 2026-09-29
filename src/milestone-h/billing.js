import { createHmac, timingSafeEqual } from "node:crypto";

const PRICE_ENV = Object.freeze({
  TEAM: "STRIPE_PRICE_TEAM",
  BUSINESS: "STRIPE_PRICE_BUSINESS",
  ENTERPRISE: "STRIPE_PRICE_ENTERPRISE",
});

function requireStripeSecret() {
  const value = String(process.env.STRIPE_SECRET_KEY || "").trim();
  if (!value) {
    const error = new Error("Stripe billing is not configured");
    error.statusCode = 424;
    error.code = "BILLING_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

function requireAppUrl() {
  const value = String(process.env.PUBLIC_APP_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(value)) {
    const error = new Error("PUBLIC_APP_URL must be configured with HTTPS");
    error.statusCode = 424;
    error.code = "PUBLIC_APP_URL_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

async function stripeRequest(path, params, fetchImpl = fetch) {
  const secret = requireStripeSecret();
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value == null) continue;
    body.set(key, String(value));
  }
  const response = await fetchImpl("https://api.stripe.com/v1/" + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + secret,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("Stripe billing request failed");
    error.statusCode = 502;
    error.code = "BILLING_PROVIDER_ERROR";
    error.providerCode = payload?.error?.code || null;
    throw error;
  }
  return payload;
}

export function priceIdForPlan(plan) {
  const normalized = String(plan || "").toUpperCase();
  const envName = PRICE_ENV[normalized];
  const value = envName ? String(process.env[envName] || "").trim() : "";
  if (!envName || !value) {
    const error = new Error("billing price is not configured for plan");
    error.statusCode = 424;
    error.code = "BILLING_PRICE_NOT_CONFIGURED";
    throw error;
  }
  return value;
}

export async function createStripeCheckout({
  workspaceId,
  plan,
  customerEmail,
  customerId = null,
  fetchImpl = fetch,
}) {
  requireStripeSecret();
  const appUrl = requireAppUrl();
  const params = {
    mode: "subscription",
    client_reference_id: workspaceId,
    success_url: appUrl + "/console?billing=success",
    cancel_url: appUrl + "/console?billing=cancelled",
    "line_items[0][price]": priceIdForPlan(plan),
    "line_items[0][quantity]": 1,
    "metadata[workspace_id]": workspaceId,
    "metadata[plan]": plan,
    "subscription_data[metadata][workspace_id]": workspaceId,
    "subscription_data[metadata][plan]": plan,
    allow_promotion_codes: "true",
  };
  if (customerId) params.customer = customerId;
  else if (customerEmail) params.customer_email = customerEmail;
  const session = await stripeRequest("checkout/sessions", params, fetchImpl);
  return {
    id: session.id,
    url: session.url,
    customerId: session.customer || customerId || null,
    expiresAt: session.expires_at
      ? new Date(Number(session.expires_at) * 1000).toISOString()
      : null,
  };
}

export async function createStripePortal({
  customerId,
  fetchImpl = fetch,
}) {
  requireStripeSecret();
  const appUrl = requireAppUrl();
  if (!customerId) {
    const error = new Error("workspace has no Stripe customer");
    error.statusCode = 409;
    error.code = "BILLING_CUSTOMER_MISSING";
    throw error;
  }
  const session = await stripeRequest(
    "billing_portal/sessions",
    {
      customer: customerId,
      return_url: appUrl + "/console",
    },
    fetchImpl,
  );
  return { id: session.id, url: session.url };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length &&
    left.length > 0 &&
    timingSafeEqual(left, right);
}

export function verifyStripeSignature({
  rawBody,
  signatureHeader,
  secret = process.env.STRIPE_WEBHOOK_SECRET,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
}) {
  const key = String(secret || "").trim();
  if (!key) return false;
  const fields = {};
  for (const part of String(signatureHeader || "").split(",")) {
    const [name, value] = part.split("=");
    if (!name || !value) continue;
    if (!fields[name]) fields[name] = [];
    fields[name].push(value);
  }
  const timestamp = Number(fields.t?.[0]);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }
  const expected = createHmac("sha256", key)
    .update(String(timestamp) + "." + rawBody.toString("utf8"))
    .digest("hex");
  return (fields.v1 || []).some((candidate) => safeEqual(candidate, expected));
}
