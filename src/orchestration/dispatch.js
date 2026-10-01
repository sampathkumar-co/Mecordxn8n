const WORKERS = Object.freeze({
  "http-observer": "MECORDXN8N_HTTP_OBSERVER_URL",
  "browser-qa": "MECORDXN8N_BROWSER_QA_URL",
  "site-discovery": "MECORDXN8N_SITE_DISCOVERY_URL",
  "journey-qa": "MECORDXN8N_JOURNEY_QA_URL",
  "finding-verification": "MECORDXN8N_VERIFICATION_URL",
  remediation: "MECORDXN8N_REMEDIATION_URL",
  "integration-delivery": "MECORDXN8N_INTEGRATION_URL",
});

export function knownDispatchWorker(name) {
  return Object.hasOwn(WORKERS, String(name || ""));
}

export async function dispatchWorkerOnce(
  name,
  {
    fetchImpl = fetch,
    triggerToken = process.env.WORKER_TRIGGER_TOKEN,
    env = process.env,
  } = {},
) {
  const envName = WORKERS[String(name || "")];
  if (!envName) {
    const error = new Error("unknown worker dispatch target");
    error.statusCode = 404;
    error.code = "WORKER_DISPATCH_NOT_FOUND";
    throw error;
  }

  const baseUrl = String(env[envName] || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    const error = new Error("worker dispatch target is not configured");
    error.statusCode = 424;
    error.code = "WORKER_DISPATCH_NOT_CONFIGURED";
    throw error;
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" || !/^[a-z0-9-]+$/i.test(parsed.hostname)) {
    const error = new Error("worker dispatch target must be an internal HTTP service name");
    error.statusCode = 500;
    error.code = "WORKER_DISPATCH_CONFIG_INVALID";
    throw error;
  }

  const token = String(triggerToken || "").trim();
  if (token.length < 32) {
    const error = new Error("worker trigger credential is not configured");
    error.statusCode = 500;
    error.code = "WORKER_TRIGGER_NOT_CONFIGURED";
    throw error;
  }

  const response = await fetchImpl(baseUrl + "/run-once", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("worker dispatch failed");
    error.statusCode = 502;
    error.code = String(payload?.error || "WORKER_DISPATCH_FAILED").slice(0, 120);
    throw error;
  }
  return {
    worker: name,
    status: response.status,
    result: payload,
  };
}
