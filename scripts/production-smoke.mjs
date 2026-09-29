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

async function check(path, {
  method = "GET",
  predicate,
} = {}) {
  const response = await fetch(base + path, {
    method,
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
results.push(await check("/healthz", {
  predicate: (res) => res.status === 404,
}));
results.push(await check("/v1/maintenance/platform", {
  method: "POST",
  predicate: (res) => res.status === 404,
}));
results.push(await check("/v1/worker/jobs/lease", {
  method: "POST",
  predicate: (res) => res.status === 404,
}));

console.log(JSON.stringify({ ok: true, base, results }));
