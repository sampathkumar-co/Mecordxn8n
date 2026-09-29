import http from "node:http";
import { timingSafeEqual } from "node:crypto";

import {
  AUTHORIZATION_MODES,
  CAPABILITIES,
  AuthorizationError,
  assertAuthorized,
} from "./authorization.js";
import {
  createAuthorizedJob,
  createTargetWithAuthorization,
  getCurrentAuthorization,
  getJob,
  pingDatabase,
  recordDeniedJob,
} from "./repository.js";

const MAX_BODY_BYTES = 256 * 1024;

function json(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function secureTokenEqual(actual, expected) {
  const a = Buffer.from(actual || "");
  const b = Buffer.from(expected || "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function requireBearer(req, expectedToken) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return secureTokenEqual(token, expectedToken);
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

  const allowedCapabilities = Array.isArray(authorization.allowedCapabilities)
    ? [...new Set(authorization.allowedCapabilities)]
    : [];

  for (const capability of allowedCapabilities) {
    if (!Object.values(CAPABILITIES).includes(capability)) {
      throw badRequest(`unknown capability: ${capability}`);
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
  if (!body?.targetId) throw badRequest("targetId is required");
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
  };
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

export function createServer({
  orchestratorToken = process.env.ORCHESTRATOR_TOKEN,
} = {}) {
  if (!orchestratorToken) {
    throw new Error("ORCHESTRATOR_TOKEN is required");
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (req.method === "GET" && url.pathname === "/healthz") {
        await pingDatabase();
        return json(res, 200, { ok: true });
      }

      if (!requireBearer(req, orchestratorToken)) {
        return json(res, 401, { error: "UNAUTHORIZED" });
      }

      if (req.method === "POST" && url.pathname === "/v1/targets") {
        const body = normalizeTargetInput(await readJson(req));
        const target = await createTargetWithAuthorization(body);
        return json(res, 201, target);
      }

      if (req.method === "POST" && url.pathname === "/v1/jobs") {
        const body = normalizeJobInput(await readJson(req));
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
        const job = await getJob(jobMatch[1]);
        if (!job) return json(res, 404, { error: "JOB_NOT_FOUND" });
        return json(res, 200, job);
      }

      return json(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return json(res, statusCode, {
        error: statusCode >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
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
