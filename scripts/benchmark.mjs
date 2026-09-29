import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import {
  AUTHORIZATION_MODES,
  CAPABILITIES,
  assertAuthorized,
} from "../src/authorization.js";
import { compareSnapshots } from "../src/milestone-b/regression.js";
import { scoreFindingIntelligence } from "../src/milestone-a/intelligence.js";

const iterations = Number(process.env.BENCHMARK_ITERATIONS || 20000);
const auth = {
  mode: AUTHORIZATION_MODES.PUBLIC_QA_ONLY,
  allowedHosts: ["example.test"],
  allowedCapabilities: [
    CAPABILITIES.PUBLIC_HTTP_OBSERVE,
    CAPABILITIES.BROWSER_QA,
  ],
};

const started = performance.now();
let regressions = 0;
for (let i = 0; i < iterations; i += 1) {
  const decision = assertAuthorized({
    authorization: auth,
    requestedCapability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
    requestedUrl: "https://example.test/checkout",
  });
  assert.equal(decision.host, "example.test");

  const result = compareSnapshots(
    {
      kind: "http",
      statusCode: 200,
      durationMs: 100,
    },
    {
      kind: "http",
      statusCode: i % 10 === 0 ? 503 : 200,
      durationMs: i % 20 === 0 ? 900 : 110,
    },
  );
  regressions += result.length;

  const scored = scoreFindingIntelligence({
    finding: {
      category: "browser-network",
      severity: "MEDIUM",
      confidence: 0.95,
      affectedUrl: "https://example.test/checkout",
      title: "Checkout request failed",
    },
    verification: { status: "VERIFIED", confidence: 0.95 },
  });
  assert.ok(scored.opportunityScore >= 0 && scored.opportunityScore <= 100);
}
const elapsedMs = performance.now() - started;
const opsPerSecond = Math.round((iterations * 3 * 1000) / elapsedMs);

const minimumOps = Number(process.env.BENCHMARK_MIN_OPS_PER_SECOND || 1000);
if (opsPerSecond < minimumOps) {
  throw new Error(
    "benchmark below floor: " + opsPerSecond + " < " + minimumOps + " ops/s",
  );
}

console.log(JSON.stringify({
  iterations,
  operations: iterations * 3,
  elapsedMs: Math.round(elapsedMs),
  opsPerSecond,
  regressions,
  minimumOpsPerSecond: minimumOps,
}));
