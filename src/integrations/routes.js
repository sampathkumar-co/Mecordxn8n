import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

import {
  accessAllows,
  getWorkspaceAccess,
} from "../platform/auth.js";
import {
  applyStripeSubscriptionEvent,
  createIntegrationConnection,
  enqueueIntegrationTest,
  getIntegrationConnection,
  getIntegrationMetrics,
  listIntegrationConnections,
  recordIntegrationWebhookReceipt,
  setIntegrationConnectionStatus,
} from "./repository.js";
import {
  INTEGRATION_PROVIDERS,
  validateIntegrationConfig,
  validateSubscribedEvents,
} from "./policy.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validId(value) {
  return UUID_RE.test(String(value || ""));
}

function constantEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return (
    left.length === right.length &&
    left.length > 0 &&
    timingSafeEqual(left, right)
  );
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

function boundedString(value, max, name, badRequest, { required = false } = {}) {
  const text = String(value || "").trim();
  if (required && !text) throw badRequest(`${name} is required`);
  if (text.length > max) throw badRequest(`${name} is too long`);
  return text || null;
}

export async function handleIntegrationPlatformRoute({
  req,
  res,
  url,
  json,
  readJson,
  badRequest,
  principal,
}) {
  let match;

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/integrations$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, {
      integrations: await listIntegrationConnections(match[1]),
    });
  }

  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "integrations:write",
    });
    if (principal.kind !== "SESSION") {
      return json(res, 403, { error: "SESSION_REQUIRED" });
    }
    const body = await readJson(req);
    const provider = String(body.provider || "").trim().toUpperCase();
    if (!INTEGRATION_PROVIDERS.includes(provider)) {
      throw badRequest("integration provider is invalid");
    }
    const config = await validateIntegrationConfig(provider, body.config);
    const subscribedEvents = validateSubscribedEvents(
      body.subscribedEvents || [],
    );
    const connection = await createIntegrationConnection({
      workspaceId: match[1],
      provider,
      name: boundedString(body.name, 160, "name", badRequest, {
        required: true,
      }),
      config,
      subscribedEvents,
      createdBy: principal.userId,
    });
    return json(res, 201, connection);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/integrations\/([0-9a-f-]+)\/(enable|disable)$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "integrations:write",
    });
    const status = match[3].toLowerCase() === "enable" ? "ACTIVE" : "DISABLED";
    const connection = await setIntegrationConnectionStatus({
      workspaceId: match[1],
      connectionId: match[2],
      status,
    });
    if (!connection) {
      return json(res, 404, { error: "INTEGRATION_NOT_FOUND" });
    }
    return json(res, 200, connection);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/integrations\/([0-9a-f-]+)\/test$/i,
  );
  if (req.method === "POST" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "ADMIN",
      apiScope: "integrations:write",
    });
    const queued = await enqueueIntegrationTest({
      workspaceId: match[1],
      connectionId: match[2],
    });
    if (!queued) {
      return json(res, 404, { error: "INTEGRATION_NOT_FOUND_OR_DISABLED" });
    }
    return json(res, 202, queued);
  }

  match = url.pathname.match(
    /^\/v1\/platform\/workspaces\/([0-9a-f-]+)\/integrations\/metrics$/i,
  );
  if (req.method === "GET" && match) {
    await requireWorkspace(principal, match[1], {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, await getIntegrationMetrics(match[1]));
  }

  return false;
}

export async function handleIntegrationWebhookRoute({
  req,
  res,
  url,
  json,
  readRaw,
}) {
  const match = url.pathname.match(
    /^\/v1\/integrations\/webhooks\/([0-9a-f-]+)\/(stripe|github)$/i,
  );
  if (req.method !== "POST" || !match) return false;
  if (!validId(match[1])) return json(res, 404, { error: "NOT_FOUND" });

  const context = await getIntegrationConnection(match[1]);
  if (!context) return json(res, 404, { error: "INTEGRATION_NOT_FOUND" });

  const provider = match[2].toUpperCase();
  if (context.connection.provider !== provider) {
    return json(res, 409, { error: "INTEGRATION_PROVIDER_MISMATCH" });
  }

  const raw = await readRaw(req, 256 * 1024);
  const payloadSha256 = createHash("sha256").update(raw).digest("hex");
  let signatureValid = false;
  let providerEventId = null;
  let eventType = "unknown";
  let parsed = null;

  if (provider === "STRIPE") {
    const signatureHeader = String(req.headers["stripe-signature"] || "");
    const parts = Object.fromEntries(
      signatureHeader
        .split(",")
        .map((part) => part.split("="))
        .filter((part) => part.length === 2),
    );
    const timestamp = parts.t;
    const signature = parts.v1;
    if (timestamp && signature) {
      const expected = createHmac("sha256", context.config.webhookSecret)
        .update(`${timestamp}.${raw.toString("utf8")}`)
        .digest("hex");
      const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
      signatureValid = ageSeconds <= 300 && constantEqual(signature, expected);
    }
  } else {
    const secret = context.config.webhookSecret;
    const signature = String(req.headers["x-hub-signature-256"] || "");
    if (secret && signature.startsWith("sha256=")) {
      const expected = createHmac("sha256", secret).update(raw).digest("hex");
      signatureValid = constantEqual(signature.slice(7), expected);
    }
  }

  if (!signatureValid) {
    await recordIntegrationWebhookReceipt({
      connectionId: context.connection.id,
      eventType,
      payloadSha256,
      signatureValid: false,
      processedState: "IGNORED",
    });
    return json(res, 401, { error: "WEBHOOK_SIGNATURE_INVALID" });
  }

  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return json(res, 400, { error: "INVALID_JSON" });
  }

  if (provider === "STRIPE") {
    providerEventId = parsed.id ? String(parsed.id).slice(0, 240) : null;
    eventType = String(parsed.type || "unknown").slice(0, 200);
    const workspaceId =
      parsed.data?.object?.metadata?.workspace_id ||
      parsed.data?.object?.metadata?.mecord_workspace_id ||
      null;
    if (
      workspaceId &&
      validId(workspaceId) &&
      [
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
      ].includes(eventType)
    ) {
      await applyStripeSubscriptionEvent({
        workspaceId,
        eventType,
        subscription: parsed.data.object,
      });
    }
  } else {
    providerEventId = req.headers["x-github-delivery"]
      ? String(req.headers["x-github-delivery"]).slice(0, 240)
      : null;
    eventType = req.headers["x-github-event"]
      ? String(req.headers["x-github-event"]).slice(0, 200)
      : "unknown";
  }

  await recordIntegrationWebhookReceipt({
    connectionId: context.connection.id,
    providerEventId,
    eventType,
    payloadSha256,
    signatureValid: true,
    processedState: "PROCESSED",
  });

  return json(res, 202, { accepted: true });
}
