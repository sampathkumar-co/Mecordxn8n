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
  completeIntegrationDelivery,
  createIntegrationConnection,
  enqueueDueRenewalIntegrationEvents,
  enqueueIntegrationTest,
  getIntegrationConnection,
  getIntegrationMetrics,
  leaseIntegrationDelivery,
  listIntegrationConnections,
  markIntegrationWebhookReceiptProcessed,
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
const MAX_WEBHOOK_BODY = 512 * 1024;

function constantEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return (
    left.length === right.length &&
    left.length > 0 &&
    timingSafeEqual(left, right)
  );
}

function pathParts(url) {
  return url.pathname.split("/").filter(Boolean);
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_WEBHOOK_BODY) {
      const error = new Error("webhook body too large");
      error.statusCode = 413;
      error.code = "WEBHOOK_BODY_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function requireWorkspace(principal, workspaceId, rule) {
  const access = await getWorkspaceAccess(principal, workspaceId);
  if (!access || !accessAllows(access, rule)) {
    const error = new Error("workspace access denied");
    error.statusCode = 403;
    error.code = "WORKSPACE_ACCESS_DENIED";
    throw error;
  }
  return access;
}

function parseStripeSignature(header) {
  const values = {};
  for (const item of String(header || "").split(",")) {
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    (values[key] ||= []).push(value);
  }
  return {
    timestamp: values.t?.[0] || null,
    signatures: values.v1 || [],
  };
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
  const path = pathParts(url);
  if (
    path.length < 5 ||
    path[0] !== "v1" ||
    path[1] !== "platform" ||
    path[2] !== "workspaces" ||
    !UUID_RE.test(path[3]) ||
    path[4] !== "integrations"
  ) {
    return false;
  }

  const workspaceId = path[3];

  if (path.length === 5 && req.method === "GET") {
    await requireWorkspace(principal, workspaceId, {
      minimumRole: "VIEWER",
      apiScope: "workspace:read",
    });
    return json(res, 200, {
      integrations: await listIntegrationConnections(workspaceId),
      metrics: await getIntegrationMetrics(workspaceId),
    });
  }

  if (path.length === 5 && req.method === "POST") {
    await requireWorkspace(principal, workspaceId, {
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
    const name = String(body.name || "").trim();
    if (!name || name.length > 160) throw badRequest("name is invalid");
    const config = await validateIntegrationConfig(provider, body.config || {});
    const subscribedEvents = validateSubscribedEvents(
      body.subscribedEvents || [],
    );
    if (provider === "STRIPE" && subscribedEvents.length > 0) {
      throw badRequest("Stripe is inbound-only in V1");
    }
    const connection = await createIntegrationConnection({
      workspaceId,
      provider,
      name,
      config,
      subscribedEvents,
      createdBy: principal.userId,
    });
    return json(res, 201, connection);
  }

  if (
    path.length === 7 &&
    UUID_RE.test(path[5]) &&
    ["enable", "disable"].includes(path[6]) &&
    req.method === "POST"
  ) {
    await requireWorkspace(principal, workspaceId, {
      minimumRole: "ADMIN",
      apiScope: "integrations:write",
    });
    const connection = await setIntegrationConnectionStatus({
      workspaceId,
      connectionId: path[5],
      status: path[6] === "enable" ? "ACTIVE" : "DISABLED",
    });
    if (!connection) {
      return json(res, 404, { error: "INTEGRATION_NOT_FOUND" });
    }
    return json(res, 200, connection);
  }

  if (
    path.length === 7 &&
    UUID_RE.test(path[5]) &&
    path[6] === "test" &&
    req.method === "POST"
  ) {
    await requireWorkspace(principal, workspaceId, {
      minimumRole: "ADMIN",
      apiScope: "integrations:write",
    });
    const context = await getIntegrationConnection(path[5], workspaceId);
    if (!context) return json(res, 404, { error: "INTEGRATION_NOT_FOUND" });
    if (context.connection.provider === "STRIPE") {
      return json(res, 409, { error: "PROVIDER_INBOUND_ONLY" });
    }
    const queued = await enqueueIntegrationTest({
      workspaceId,
      connectionId: path[5],
    });
    if (!queued) {
      return json(res, 409, { error: "INTEGRATION_NOT_ACTIVE" });
    }
    return json(res, 202, queued);
  }

  return false;
}

export async function handleIntegrationWebhookRoute({
  req,
  res,
  url,
  json,
}) {
  if (req.method !== "POST") return false;
  const path = pathParts(url);
  if (
    path.length !== 5 ||
    path[0] !== "v1" ||
    path[1] !== "integrations" ||
    path[2] !== "webhooks" ||
    !UUID_RE.test(path[3]) ||
    !["github", "stripe"].includes(path[4])
  ) {
    return false;
  }

  const connectionId = path[3];
  const providerName = path[4].toUpperCase();
  const context = await getIntegrationConnection(connectionId);
  if (!context || context.connection.status !== "ACTIVE") {
    return json(res, 404, { error: "INTEGRATION_NOT_FOUND" });
  }
  if (context.connection.provider !== providerName) {
    return json(res, 404, { error: "WEBHOOK_PROVIDER_MISMATCH" });
  }

  const raw = await readRawBody(req);
  const payloadSha256 = createHash("sha256").update(raw).digest("hex");

  if (providerName === "GITHUB") {
    if (!context.config.webhookSecret) {
      return json(res, 409, { error: "GITHUB_WEBHOOK_NOT_CONFIGURED" });
    }
    const supplied = String(req.headers["x-hub-signature-256"] || "");
    const expected =
      "sha256=" +
      createHmac("sha256", context.config.webhookSecret)
        .update(raw)
        .digest("hex");
    if (!constantEqual(supplied, expected)) {
      await recordIntegrationWebhookReceipt({
        connectionId,
        eventType: "unknown",
        payloadSha256,
        signatureValid: false,
        processedState: "IGNORED",
      });
      return json(res, 401, { error: "INVALID_WEBHOOK_SIGNATURE" });
    }

    const providerEventId =
      String(req.headers["x-github-delivery"] || "").slice(0, 240) || null;
    const eventType =
      String(req.headers["x-github-event"] || "unknown").slice(0, 200);
    const receipt = await recordIntegrationWebhookReceipt({
      connectionId,
      providerEventId,
      eventType,
      payloadSha256,
      signatureValid: true,
      processedState: "RECORDED",
    });
    if (!receipt) return json(res, 200, { accepted: true, duplicate: true });
    await markIntegrationWebhookReceiptProcessed({
      receiptId: receipt.id,
      processedState: "PROCESSED",
    });
    return json(res, 202, { accepted: true, duplicate: false });
  }

  const parsedSignature = parseStripeSignature(req.headers["stripe-signature"]);
  const timestamp = Number(parsedSignature.timestamp);
  if (
    !Number.isFinite(timestamp) ||
    Math.abs(Date.now() / 1000 - timestamp) > 300
  ) {
    return json(res, 401, { error: "INVALID_WEBHOOK_SIGNATURE" });
  }
  const signed = Buffer.concat([
    Buffer.from(String(timestamp) + ".", "utf8"),
    raw,
  ]);
  const expected = createHmac("sha256", context.config.webhookSecret)
    .update(signed)
    .digest("hex");
  if (
    !parsedSignature.signatures.some((signature) =>
      constantEqual(signature, expected),
    )
  ) {
    await recordIntegrationWebhookReceipt({
      connectionId,
      eventType: "unknown",
      payloadSha256,
      signatureValid: false,
      processedState: "IGNORED",
    });
    return json(res, 401, { error: "INVALID_WEBHOOK_SIGNATURE" });
  }

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return json(res, 400, { error: "INVALID_WEBHOOK_JSON" });
  }

  const providerEventId = String(event?.id || "").slice(0, 240) || null;
  const eventType = String(event?.type || "unknown").slice(0, 200);
  const receipt = await recordIntegrationWebhookReceipt({
    connectionId,
    providerEventId,
    eventType,
    payloadSha256,
    signatureValid: true,
    processedState: "RECORDED",
  });
  if (!receipt) return json(res, 200, { accepted: true, duplicate: true });

  try {
    if (
      [
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
      ].includes(eventType)
    ) {
      const metadataWorkspace =
        event?.data?.object?.metadata?.workspace_id ||
        event?.data?.object?.metadata?.mecord_workspace_id ||
        null;
      if (
        metadataWorkspace &&
        metadataWorkspace !== context.connection.workspaceId
      ) {
        const error = new Error("Stripe workspace metadata mismatch");
        error.statusCode = 409;
        error.code = "STRIPE_WORKSPACE_MISMATCH";
        throw error;
      }
      await applyStripeSubscriptionEvent({
        workspaceId: context.connection.workspaceId,
        eventType,
        subscription: event?.data?.object || {},
      });
    }
    await markIntegrationWebhookReceiptProcessed({
      receiptId: receipt.id,
      processedState: "PROCESSED",
    });
    return json(res, 202, { accepted: true, duplicate: false });
  } catch (error) {
    await markIntegrationWebhookReceiptProcessed({
      receiptId: receipt.id,
      processedState: "FAILED",
    });
    throw error;
  }
}

export async function handleIntegrationWorkerRoute({
  req,
  res,
  url,
  json,
  readJson,
  badRequest,
}) {
  const path = pathParts(url);
  if (
    path[0] !== "v1" ||
    path[1] !== "worker" ||
    path[2] !== "integrations"
  ) {
    return false;
  }

  if (req.method === "POST" && path.length === 4 && path[3] === "lease") {
    const body = await readJson(req);
    const workerId = String(body.workerId || "").trim();
    const leaseSeconds = Number(body.leaseSeconds || 60);
    if (
      !workerId ||
      workerId.length > 160 ||
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 15 ||
      leaseSeconds > 300
    ) {
      throw badRequest("integration lease request is invalid");
    }
    const delivery = await leaseIntegrationDelivery({
      workerId,
      leaseSeconds,
    });
    if (!delivery) return json(res, 204, {});
    return json(res, 200, delivery);
  }

  if (
    req.method === "POST" &&
    path.length === 5 &&
    UUID_RE.test(path[3]) &&
    path[4] === "complete"
  ) {
    const body = await readJson(req);
    const workerId = String(body.workerId || "").trim();
    const state = String(body.state || "").trim().toUpperCase();
    if (!workerId || !["SENT", "FAILED"].includes(state)) {
      throw badRequest("integration completion is invalid");
    }
    const completed = await completeIntegrationDelivery({
      deliveryId: path[3],
      workerId,
      state,
      providerReference: body.providerReference
        ? String(body.providerReference).slice(0, 1000)
        : null,
      errorCode: body.errorCode
        ? String(body.errorCode).slice(0, 120)
        : null,
    });
    if (!completed) {
      return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
    }
    return json(res, 200, completed);
  }

  if (
    req.method === "POST" &&
    path.length === 4 &&
    path[3] === "maintenance"
  ) {
    const body = await readJson(req);
    const limit = Math.min(
      Math.max(Math.trunc(Number(body.limit) || 100), 1),
      500,
    );
    return json(res, 200, {
      renewalsQueued: await enqueueDueRenewalIntegrationEvents(limit),
    });
  }

  return false;
}
