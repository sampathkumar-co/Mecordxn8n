import { timingSafeEqual } from "node:crypto";
import { CAPABILITIES } from "../authorization.js";

const DEFINITIONS = Object.freeze([
  {
    id: "public-http-observer",
    env: "WORKER_TOKEN_HTTP_OBSERVER",
    capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
    routeGroup: "PUBLIC_QA",
  },
  {
    id: "browser-qa-worker",
    env: "WORKER_TOKEN_BROWSER_QA",
    capabilities: [CAPABILITIES.BROWSER_QA],
    routeGroup: "PUBLIC_QA",
  },
  {
    id: "site-discovery-worker",
    env: "WORKER_TOKEN_SITE_DISCOVERY",
    capabilities: [CAPABILITIES.SITE_DISCOVERY],
    routeGroup: "SITE_DISCOVERY",
  },
  {
    id: "journey-qa-worker",
    env: "WORKER_TOKEN_JOURNEY_QA",
    capabilities: [CAPABILITIES.JOURNEY_QA],
    routeGroup: "JOURNEY",
  },
  {
    id: "finding-verification-worker",
    env: "WORKER_TOKEN_FINDING_VERIFICATION",
    capabilities: [CAPABILITIES.FINDING_VERIFY],
    routeGroup: "VERIFICATION",
  },
  {
    id: "mecord-remediation-worker",
    env: "WORKER_TOKEN_REMEDIATION",
    capabilities: [CAPABILITIES.SOURCE_REMEDIATION],
    routeGroup: "REMEDIATION",
  },
  {
    id: "integration-delivery-worker",
    env: "WORKER_TOKEN_INTEGRATION",
    capabilities: [],
    routeGroup: "INTEGRATION",
  },
]);

function tokenEqual(actual, expected) {
  const a = Buffer.from(String(actual || ""));
  const b = Buffer.from(String(expected || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export function buildWorkerCredentials({
  env = process.env,
  legacyToken = env.WORKER_TOKEN,
} = {}) {
  const configured = DEFINITIONS
    .map((item) => ({
      ...item,
      token: String(env[item.env] || "").trim(),
    }))
    .filter((item) => item.token);

  if (configured.length) return configured;

  const fallback = String(legacyToken || "").trim();
  if (!fallback) return [];
  return [{
    id: null,
    token: fallback,
    capabilities: Object.values(CAPABILITIES),
    routeGroup: "LEGACY",
    legacy: true,
  }];
}

export function authenticateWorkerCredential(rawToken, credentials) {
  for (const credential of credentials || []) {
    if (tokenEqual(rawToken, credential.token)) {
      return {
        workerId: credential.id,
        capabilities: credential.capabilities || [],
        routeGroup: credential.routeGroup,
        legacy: Boolean(credential.legacy),
      };
    }
  }
  return null;
}

function genericJobPath(pathname) {
  return (
    pathname === "/v1/worker/jobs/lease" ||
    /^\/v1\/worker\/jobs\/[0-9a-f-]+\/(findings|complete|heartbeat)$/i.test(pathname)
  );
}

export function workerPathAllowed(principal, pathname) {
  if (!principal) return false;
  if (principal.legacy) return true;

  if (principal.routeGroup === "INTEGRATION") {
    return pathname.startsWith("/v1/worker/integrations/");
  }
  if (pathname.startsWith("/v1/worker/integrations/")) return false;

  if (genericJobPath(pathname)) return true;

  if (
    pathname.match(/^\/v1\/worker\/milestone-a\/findings\/[0-9a-f-]+$/i)
  ) {
    return ["VERIFICATION", "REMEDIATION"].includes(principal.routeGroup);
  }
  if (
    pathname.match(/^\/v1\/worker\/milestone-a\/jobs\/[0-9a-f-]+\/pages$/i)
  ) {
    return principal.routeGroup === "SITE_DISCOVERY";
  }
  if (
    pathname.match(/^\/v1\/worker\/milestone-a\/jobs\/[0-9a-f-]+\/journey-run$/i)
  ) {
    return principal.routeGroup === "JOURNEY";
  }
  if (
    pathname.match(/^\/v1\/worker\/milestone-a\/jobs\/[0-9a-f-]+\/verification$/i)
  ) {
    return principal.routeGroup === "VERIFICATION";
  }
  if (
    pathname.match(/^\/v1\/worker\/milestone-a\/jobs\/[0-9a-f-]+\/remediation-result$/i)
  ) {
    return principal.routeGroup === "REMEDIATION";
  }
  if (
    pathname.match(/^\/v1\/worker\/milestone-b\/jobs\/[0-9a-f-]+\/(monitoring-run|monitoring-failure)$/i)
  ) {
    return principal.routeGroup === "PUBLIC_QA";
  }
  if (
    pathname.match(/^\/v1\/worker\/milestone-b\/jobs\/[0-9a-f-]+\/repair-outcome$/i) ||
    pathname === "/v1/worker/milestone-b/repair-patterns"
  ) {
    return principal.routeGroup === "REMEDIATION";
  }

  return false;
}

export function assertWorkerBody(principal, body) {
  if (!principal || principal.legacy || !body || typeof body !== "object") return body;

  if (body.workerId && body.workerId !== principal.workerId) {
    const error = new Error("worker credential does not match workerId");
    error.statusCode = 403;
    error.code = "WORKER_IDENTITY_MISMATCH";
    throw error;
  }

  if (Array.isArray(body.capabilities)) {
    const allowed = new Set(principal.capabilities);
    if (body.capabilities.some((capability) => !allowed.has(capability))) {
      const error = new Error("worker requested a capability outside its credential scope");
      error.statusCode = 403;
      error.code = "WORKER_CAPABILITY_SCOPE";
      throw error;
    }
  }

  return body;
}

export const WORKER_CREDENTIAL_DEFINITIONS = DEFINITIONS;
