function enabled(env = process.env) {
  return String(env.DEPENDENCY_HEALTH_ENABLED || "").trim().toLowerCase() === "true";
}

async function probe(name, url, {
  fetchImpl = fetch,
  headers = {},
} = {}) {
  if (!url) {
    return { name, configured: false, reachable: false, status: "NOT_CONFIGURED" };
  }
  const started = performance.now();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(4_000),
    });
    const reachable = response.status >= 200 && response.status < 500;
    return {
      name,
      configured: true,
      reachable,
      status: reachable ? "REACHABLE" : "UNREACHABLE",
      httpStatus: response.status,
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  } catch {
    return {
      name,
      configured: true,
      reachable: false,
      status: "UNREACHABLE",
      latencyMs: Math.max(0, Math.round(performance.now() - started)),
    };
  }
}

export async function getDependencyHealth({
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!enabled(env)) {
    return {
      enabled: false,
      status: "DISABLED",
      dependencies: {},
    };
  }

  const n8n = await probe("n8n", String(env.N8N_HEALTH_URL || "").trim(), {
    fetchImpl,
  });
  const mecord = await probe(
    "mecord",
    String(env.MECORD_HEALTH_URL || "").trim(),
    {
      fetchImpl,
      headers: env.MECORD_MCP_TOKEN
        ? { Authorization: `Bearer ${env.MECORD_MCP_TOKEN}` }
        : {},
    },
  );
  const dependencies = { n8n, mecord };
  const healthy = Object.values(dependencies).every(
    (item) => item.configured && item.reachable,
  );
  return {
    enabled: true,
    status: healthy ? "HEALTHY" : "ATTENTION",
    dependencies,
  };
}
