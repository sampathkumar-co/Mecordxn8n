const base = String(process.env.PUBLIC_APP_URL || process.argv[2] || "")
  .trim()
  .replace(/\/+$/, "");
if (!/^https?:\/\//i.test(base)) {
  throw new Error("PUBLIC_APP_URL or base URL argument is required");
}

async function check(path, predicate) {
  const response = await fetch(base + path, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (!predicate(response, body)) {
    throw new Error(path + " smoke check failed with HTTP " + response.status);
  }
  return { path, status: response.status };
}

const results = [];
results.push(await check("/livez", (res, body) =>
  res.status === 200 && body.includes('"ok":true')));
results.push(await check("/healthz", (res, body) =>
  res.status === 200 && body.includes('"database":"ready"')));
results.push(await check("/console", (res, body) =>
  res.status === 200 && body.includes("Mecordxn8n")));

console.log(JSON.stringify({ ok: true, base, results }));
