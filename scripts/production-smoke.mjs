import { verifyPublicAssets } from "./verify-public-assets.mjs";

const base = String(process.env.PUBLIC_APP_URL || process.argv[2] || "")
  .trim()
  .replace(/\/+$/, "");

let parsed;
try {
  parsed = new URL(base);
} catch {
  throw new Error("PUBLIC_APP_URL or base URL argument is required");
}
if (parsed.protocol !== "https:") {
  throw new Error("production smoke checks require HTTPS");
}

const strict =
  String(process.env.PRODUCTION_SMOKE_STRICT || "").trim().toLowerCase() ===
  "true";
const smokeApiKey = String(process.env.SMOKE_API_KEY || "").trim();
const smokeWorkspaceId = String(process.env.SMOKE_WORKSPACE_ID || "").trim();

if (strict && (!smokeApiKey || !smokeWorkspaceId)) {
  throw new Error(
    "strict production smoke requires SMOKE_API_KEY and SMOKE_WORKSPACE_ID",
  );
}

async function check(path, {
  method = "GET",
  predicate,
  headers = {},
} = {}) {
  const response = await fetch(base + path, {
    method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (!predicate(response, body)) {
    throw new Error(
      method + " " + path + " smoke check failed with HTTP " + response.status,
    );
  }
  return { path, method, status: response.status };
}

const results = [];
results.push(await check("/livez", {
  predicate: (res, body) =>
    res.status === 200 && body.includes('"ok":true'),
}));
results.push(await check("/console", {
  predicate: (res, body) =>
    res.status === 200 &&
    body.includes("Mecordxn8n") &&
    /max-age=31536000/i.test(res.headers.get("strict-transport-security") || "") &&
    (res.headers.get("x-frame-options") || "").toUpperCase() === "DENY" &&
    (res.headers.get("x-content-type-options") || "").toLowerCase() === "nosniff",
}));
for (const hidden of [
  ["/healthz", "GET"],
  ["/metrics", "GET"],
  ["/v1/maintenance/platform", "POST"],
  ["/v1/worker/jobs/lease", "POST"],
]) {
  results.push(await check(hidden[0], {
    method: hidden[1],
    predicate: (res) => res.status === 404,
  }));
}

if (strict) {
  const authorization = { Authorization: "Bearer " + smokeApiKey };
  results.push(await check("/v1/platform/me", {
    headers: authorization,
    predicate: (res, body) => {
      if (res.status !== 200) return false;
      try {
        const payload = JSON.parse(body);
        return (
          payload.principal?.kind === "API_KEY" &&
          (payload.workspaces || []).some(
            (workspace) => workspace.id === smokeWorkspaceId,
          )
        );
      } catch {
        return false;
      }
    },
  }));
  results.push(await check(
    "/v1/platform/workspaces/" + smokeWorkspaceId + "/overview",
    {
      headers: authorization,
      predicate: (res, body) => {
        if (res.status !== 200) return false;
        try {
          const payload = JSON.parse(body);
          return payload && typeof payload === "object";
        } catch {
          return false;
        }
      },
    },
  ));
  results.push(await check(
    "/v1/platform/workspaces/" + smokeWorkspaceId + "/health",
    {
      headers: authorization,
      predicate: (res, body) => {
        if (res.status !== 200) return false;
        try {
          const payload = JSON.parse(body);
          return ["HEALTHY", "ATTENTION"].includes(payload.status);
        } catch {
          return false;
        }
      },
    },
  ));
  results.push(await check(
    "/v1/platform/workspaces/" + smokeWorkspaceId + "/targets?limit=5",
    {
      headers: authorization,
      predicate: (res, body) => {
        if (res.status !== 200) return false;
        try {
          return Array.isArray(JSON.parse(body).targets);
        } catch {
          return false;
        }
      },
    },
  ));
  results.push(await check(
    "/v1/platform/workspaces/" + smokeWorkspaceId + "/integrations",
    {
      headers: authorization,
      predicate: (res, body) => {
        if (res.status !== 200) return false;
        try {
          return Array.isArray(JSON.parse(body).integrations);
        } catch {
          return false;
        }
      },
    },
  ));
}

if (strict) {
  const audit = await verifyPublicAssets(base);
  if (!audit.ok) {
    throw new Error(
      "Strict deployment smoke: public console assets do not match checked-out release " +
      JSON.stringify(audit.failures.slice(0, 8)),
    );
  }
  results.push({ path: "/console/*", method: "GET", status: 200, assetsVerified: audit.checked });
}

console.log(JSON.stringify({ ok: true, base, strict, results }));
