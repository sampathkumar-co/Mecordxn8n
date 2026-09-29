import http from "node:http";
import { timingSafeEqual } from "node:crypto";

import {
  AUTHORIZATION_MODES,
  CAPABILITIES,
  AuthorizationError,
  assertAuthorized,
} from "./authorization.js";
import {
  completeLeasedJob,
  createAuthorizedJob,
  createTargetWithAuthorization,
  getCurrentAuthorization,
  getJob,
  leaseNextJob,
  pingDatabase,
  recordDeniedJob,
  upsertFindingFromLease,
} from "./repository.js";
import { handleMilestoneARoute } from "./milestone-a/routes.js";
import { handleMilestoneBRoute } from "./milestone-b/routes.js";
import { handleMilestoneCRoute } from "./milestone-c/routes.js";
import { authenticatePlatformToken } from "./platform/auth.js";
import {
  handlePlatformPublicRoute,
  handlePlatformRoute,
  runPlatformMaintenance,
} from "./platform/routes.js";
import { serveConsoleAsset } from "./platform/static.js";
import {
  handleIntegrationPlatformRoute,
  handleIntegrationWebhookRoute,
  handleIntegrationWorkerRoute,
} from "./integrations/routes.js";

const MAX_BODY_BYTES = 256 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
  });
  res.end(body);
}

function secureTokenEqual(actual, expected) {
  const a = Buffer.from(actual || "");
  const b = Buffer.from(expected || "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function requireBearer(req, expectedToken) {
  return secureTokenEqual(bearerToken(req), expectedToken);
}

async function readRaw(req, maxBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("request body too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function normalizeTargetInput(body) {
  if (!body || typeof body !== "object") throw badRequest("body is required");
  if (!body.organizationName?.trim()) throw badRequest("organizationName is required");
  if (!body.baseUrl) throw badRequest("baseUrl is required");
  if (!body.authorization || typeof body.authorization !== "object") {
    throw badRequest("authorization is required");
  }

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
  if (!Object.values(AUTHORIZATION_MODES).includes(authorization.mode)) {
    throw badRequest("authorization.mode is invalid");
  }

  const allowedHosts = Array.isArray(authorization.allowedHosts)
    ? [...new Set(authorization.allowedHosts.map((v) => String(v).trim().toLowerCase()).filter(Boolean))]
    : [];

  if (allowedHosts.length === 0) {
    throw badRequest("authorization.allowedHosts must contain at least one exact hostname");
  }

  if (!allowedHosts.includes(base.hostname.toLowerCase())) {
    throw badRequest("baseUrl hostname must be present in authorization.allowedHosts");
  }

  const allowedCapabilities = Array.isArray(authorization.allowedCapabilities)
    ? [...new Set(authorization.allowedCapabilities)]
    : [];

  for (const capability of allowedCapabilities) {
    if (!Object.values(CAPABILITIES).includes(capability)) {
      throw badRequest(`unknown capability: ${capability}`);
    }
  }

  if (authorization.expiresAt) {
    const expiry = new Date(authorization.expiresAt);
    if (Number.isNaN(expiry.getTime())) {
      throw badRequest("authorization.expiresAt is invalid");
    }
    if (expiry.getTime() <= Date.now()) {
      throw badRequest("authorization.expiresAt must be in the future");
    }
  }

  if (
    [AUTHORIZATION_MODES.BUG_BOUNTY, AUTHORIZATION_MODES.CLIENT_AUTHORIZED].includes(
      authorization.mode,
    ) &&
    !authorization.expiresAt
  ) {
    throw badRequest("privileged authorization modes require expiresAt");
  }

  return {
    organizationName: body.organizationName.trim(),
    baseUrl: base.toString(),
    authorization: {
      mode: authorization.mode,
      allowedHosts,
      allowedCapabilities,
      scopeNotes: authorization.scopeNotes || null,
      evidenceReference: authorization.evidenceReference || null,
      expiresAt: authorization.expiresAt || null,
    },
  };
}

function normalizeJobInput(body) {
  if (!body?.targetId || !UUID_RE.test(body.targetId)) {
    throw badRequest("targetId must be a valid UUID");
  }
  if (!body?.jobType?.trim()) throw badRequest("jobType is required");
  if (!Object.values(CAPABILITIES).includes(body.capability)) {
    throw badRequest("capability is invalid");
  }
  if (!body.requestedUrl) throw badRequest("requestedUrl is required");

  return {
    targetId: body.targetId,
    jobType: body.jobType.trim(),
    capability: body.capability,
    requestedUrl: body.requestedUrl,
    input: body.input || {},
    maxAttempts:
      body.maxAttempts == null
        ? 3
        : Math.min(Math.max(Number(body.maxAttempts) || 3, 1), 10),
  };
}

function normalizeLeaseInput(body) {
  if (!body?.workerId?.trim()) throw badRequest("workerId is required");
  if (!Array.isArray(body.capabilities) || body.capabilities.length === 0) {
    throw badRequest("capabilities must contain at least one capability");
  }

  const capabilities = [...new Set(body.capabilities)];
  for (const capability of capabilities) {
    if (!Object.values(CAPABILITIES).includes(capability)) {
      throw badRequest(`unknown capability: ${capability}`);
    }
  }

  const leaseSeconds = Number(body.leaseSeconds ?? 60);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 300) {
    throw badRequest("leaseSeconds must be an integer from 15 to 300");
  }

  return {
    workerId: body.workerId.trim(),
    capabilities,
    leaseSeconds,
  };
}

function normalizeFindingInput(body) {
  if (!body?.workerId?.trim()) throw badRequest("workerId is required");
  const finding = body.finding;
  if (!finding || typeof finding !== "object") throw badRequest("finding is required");
  if (!finding.fingerprint?.trim()) throw badRequest("finding.fingerprint is required");
  if (!finding.category?.trim()) throw badRequest("finding.category is required");
  if (!finding.title?.trim()) throw badRequest("finding.title is required");
  if (!["INFO", "LOW", "MEDIUM", "HIGH"].includes(finding.severity)) {
    throw badRequest("finding.severity is invalid");
  }

  const confidence = Number(finding.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw badRequest("finding.confidence must be between 0 and 1");
  }
  if (!finding.affectedUrl) throw badRequest("finding.affectedUrl is required");

  return {
    workerId: body.workerId.trim(),
    finding: {
      fingerprint: finding.fingerprint.trim(),
      category: finding.category.trim(),
      title: finding.title.trim(),
      severity: finding.severity,
      confidence,
      affectedUrl: finding.affectedUrl,
      evidence: finding.evidence || {},
    },
  };
}

function normalizeCompletionInput(body) {
  if (!body?.workerId?.trim()) throw badRequest("workerId is required");
  if (!["SUCCEEDED", "FAILED"].includes(body.state)) {
    throw badRequest("state must be SUCCEEDED or FAILED");
  }

  return {
    workerId: body.workerId.trim(),
    state: body.state,
    output: body.output || null,
    error: body.error || null,
  };
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function createServer({
  orchestratorToken = process.env.ORCHESTRATOR_TOKEN,
  workerToken = process.env.WORKER_TOKEN,
  bootstrapToken = process.env.BOOTSTRAP_TOKEN,
} = {}) {
  if (!orchestratorToken) {
    throw new Error("ORCHESTRATOR_TOKEN is required");
  }
  if (!workerToken) {
    throw new Error("WORKER_TOKEN is required");
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (req.method === "GET" && url.pathname === "/livez") {
        return json(res, 200, { ok: true });
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        await pingDatabase();
        return json(res, 200, { ok: true, database: "ready" });
      }

      if (url.pathname.startsWith("/console")) {
        const served = await serveConsoleAsset(req, res, url);
        if (served) return;
      }

      if (url.pathname.startsWith("/v1/integrations/webhooks/")) {
        const handled = await handleIntegrationWebhookRoute({
          req,
          res,
          url,
          json,
          readRaw,
        });
        if (handled !== false) return;
      }

      if (url.pathname.startsWith("/v1/platform/")) {
        const rawBearer = bearerToken(req);
        const publicHandled = await handlePlatformPublicRoute({
          req,
          res,
          url,
          json,
          readJson,
          badRequest,
          bootstrapToken,
          bearerToken: rawBearer,
        });
        if (publicHandled !== false) return;

        const principal = await authenticatePlatformToken(rawBearer);
        if (!principal) {
          return json(res, 401, { error: "PLATFORM_UNAUTHORIZED" });
        }
        const integrationHandled = await handleIntegrationPlatformRoute({
          req,
          res,
          url,
          json,
          readJson,
          badRequest,
          principal,
        });
        if (integrationHandled !== false) return;

        const platformHandled = await handlePlatformRoute({
          req,
          res,
          url,
          json,
          readJson,
          badRequest,
          principal,
        });
        if (platformHandled !== false) return;
        return json(res, 404, { error: "NOT_FOUND" });
      }

      const workerRoute = url.pathname.startsWith("/v1/worker/");
      if (!requireBearer(req, workerRoute ? workerToken : orchestratorToken)) {
        return json(res, 401, { error: "UNAUTHORIZED" });
      }

      if (
        req.method === "POST" &&
        url.pathname === "/v1/maintenance/platform"
      ) {
        return json(res, 200, await runPlatformMaintenance());
      }

      const integrationWorkerHandled = await handleIntegrationWorkerRoute({
        req,
        res,
        url,
        json,
        readJson,
        badRequest,
      });
      if (integrationWorkerHandled !== false) return;

      const milestoneCHandled = await handleMilestoneCRoute({
        req,
        res,
        url,
        json,
        readJson,
        badRequest,
      });
      if (milestoneCHandled !== false) return;

      const milestoneBHandled = await handleMilestoneBRoute({
        req,
        res,
        url,
        json,
        readJson,
        badRequest,
      });
      if (milestoneBHandled !== false) return;

      const milestoneAHandled = await handleMilestoneARoute({
        req,
        res,
        url,
        json,
        readJson,
        badRequest,
      });
      if (milestoneAHandled !== false) return;

      if (req.method === "POST" && url.pathname === "/v1/worker/jobs/lease") {
        const body = normalizeLeaseInput(await readJson(req));
        const job = await leaseNextJob(body);
        if (!job) return json(res, 204, {});
        return json(res, 200, job);
      }

      const findingMatch = url.pathname.match(/^\/v1\/worker\/jobs\/([0-9a-f-]+)\/findings$/i);
      if (req.method === "POST" && findingMatch) {
        if (!UUID_RE.test(findingMatch[1])) throw badRequest("job id is invalid");
        const body = normalizeFindingInput(await readJson(req));
        const finding = await upsertFindingFromLease({
          jobId: findingMatch[1],
          ...body,
        });
        if (!finding) {
          return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
        }
        return json(res, 201, finding);
      }

      const completionMatch = url.pathname.match(/^\/v1\/worker\/jobs\/([0-9a-f-]+)\/complete$/i);
      if (req.method === "POST" && completionMatch) {
        if (!UUID_RE.test(completionMatch[1])) throw badRequest("job id is invalid");
        const body = normalizeCompletionInput(await readJson(req));
        const job = await completeLeasedJob({
          jobId: completionMatch[1],
          ...body,
        });
        if (!job) {
          return json(res, 409, { error: "LEASE_NOT_OWNED_OR_EXPIRED" });
        }
        return json(res, 200, job);
      }

      if (req.method === "POST" && url.pathname === "/v1/targets") {
        const body = normalizeTargetInput(await readJson(req));
        const target = await createTargetWithAuthorization(body);
        return json(res, 201, target);
      }

      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        const body = normalizeJobInput(await readJson(req));
        if (body.capability === CAPABILITIES.SOURCE_REMEDIATION) {
          return json(res, 403, {
            error: "APPROVAL_REQUIRED",
            message: "source remediation must be requested through the finding approval flow",
          });
        }
        const authorization = await getCurrentAuthorization(body.targetId);

        let decision;
        try {
          decision = assertAuthorized({
            authorization,
            requestedCapability: body.capability,
            requestedUrl: body.requestedUrl,
          });
        } catch (error) {
          if (error instanceof AuthorizationError) {
            await recordDeniedJob({
              ...body,
              targetId: authorization ? body.targetId : null,
              code: error.code,
              message: error.message,
            });
            return json(res, 403, {
              error: error.code,
              message: error.message,
            });
          }
          throw error;
        }

        const job = await createAuthorizedJob({
          ...body,
          authorizationId: authorization.id,
          decision,
        });

        return json(res, 201, job);
      }

      const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]+)$/i);
      if (req.method === "GET" && jobMatch) {
        if (!UUID_RE.test(jobMatch[1])) throw badRequest("job id is invalid");
        const job = await getJob(jobMatch[1]);
        if (!job) return json(res, 404, { error: "JOB_NOT_FOUND" });
        return json(res, 200, job);
      }

      return json(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return json(res, statusCode, {
        error: statusCode >= 500 ? "INTERNAL_ERROR" : (error.code || "BAD_REQUEST"),
        message: statusCode >= 500 ? "unexpected server error" : error.message,
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8080);
  const server = createServer();
  server.listen(port, () => {
    console.log(`mecordxn8n control API listening on :${port}`);
  });
}
