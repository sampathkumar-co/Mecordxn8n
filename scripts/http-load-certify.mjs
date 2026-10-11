// Controlled benchmark: isolated loopback application only, never production.
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

const base = new URL(process.env.LOAD_TEST_URL || "http://127.0.0.1:18081");
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) || base.protocol !== "http:") {
  throw new Error("The certification benchmark is restricted to local nonproduction HTTP servers");
}
const durationMs = Math.min(90_000, Math.max(3_000, Number(process.env.LOAD_DURATION_MS || 45_000)));
const concurrency = Math.min(20, Math.max(1, Number(process.env.LOAD_CONCURRENCY || 8)));
const maxRequests = Math.min(12_000, Math.max(50, Number(process.env.LOAD_MAX_REQUESTS || 4000)));
const id = randomUUID().slice(0, 12);
const signup = await fetch(new URL("/v1/platform/auth/signup", base), {
  method: "POST",
  redirect: "manual",
  headers: {"content-type":"application/json"},
  body: JSON.stringify({
    email: "bench-" + id + "@example.test",
    displayName: "Isolated Load Benchmark",
    password: "Load-test-password-12345",
    workspaceName: "Load Benchmark " + id,
    workspaceSlug: "load-" + id,
  }),
  signal: AbortSignal.timeout(10_000),
});
if (signup.status !== 201) throw new Error("Isolated test signup failed with HTTP " + signup.status);
const account = await signup.json();
if (!account.token || !account.workspace?.id) throw new Error("Missing isolated test session");
const target = new URL("/v1/platform/workspaces/" + encodeURIComponent(account.workspace.id) + "/onboarding", base);
const startedAt = new Date().toISOString();
const begun = performance.now();
const counts = {};
const latencies = [];
let reserved = 0;
async function worker() {
  while (performance.now() - begun < durationMs && reserved < maxRequests) {
    reserved += 1;
    const start = performance.now();
    try {
      const res = await fetch(target, {
        headers: {authorization: "Bearer " + account.token},
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
      });
      await res.arrayBuffer();
      counts[res.status] = (counts[res.status] || 0) + 1;
    } catch (e) {
      counts.networkError = (counts.networkError || 0) + 1;
    }
    latencies.push(performance.now() - start);
    await sleep(120);
  }
}
await Promise.all(Array.from({length: concurrency}, worker));
const elapsedMs = performance.now() - begun;
latencies.sort((a,b) => a-b);
const pct = n => latencies[Math.min(latencies.length-1, Math.floor(n*(latencies.length-1)))];
const report = {
  kind:"isolated-authenticated-api-load",startedAt,concurrency,durationMs:Math.round(elapsedMs),
  requests:latencies.length,statusCounts:counts,requestsPerSecond:Number((latencies.length*1000/elapsedMs).toFixed(2)),
  p50Ms:Number(pct(.5).toFixed(2)),p95Ms:Number(pct(.95).toFixed(2)),
  p99Ms:Number(pct(.99).toFixed(2)),maxMs:Number(latencies.at(-1).toFixed(2)),
  databaseBacked:true,prodCertified:false
};
console.log(JSON.stringify(report));
if ((counts["200"]||0)!==latencies.length) process.exitCode=1;
