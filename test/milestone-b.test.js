import test from "node:test";
import assert from "node:assert/strict";

import {
  compareSnapshots,
  normalizeMonitoringSnapshot,
  snapshotFingerprint,
} from "../src/milestone-b/regression.js";
import {
  extractRepairLearning,
  repairPatternKey,
} from "../src/milestone-b/repair-intelligence.js";

test("HTTP monitoring detects availability and latency regressions", () => {
  const previous = normalizeMonitoringSnapshot("PUBLIC_HTTP_OBSERVE", {
    statusCode: 200,
    latencyMs: 120,
    headers: { contentType: "text/html" },
  });
  const current = normalizeMonitoringSnapshot("PUBLIC_HTTP_OBSERVE", {
    statusCode: 503,
    latencyMs: 1500,
    headers: { contentType: "text/html" },
  });

  const regressions = compareSnapshots(previous, current);
  assert.ok(regressions.some((item) => item.category === "availability"));
  assert.ok(regressions.some((item) => item.category === "performance"));
});

test("browser monitoring detects newly introduced runtime failures", () => {
  const previous = normalizeMonitoringSnapshot("BROWSER_QA", {
    mainStatus: 200,
    durationMs: 300,
    title: "Checkout",
    pageErrors: [],
    consoleErrors: [],
    httpErrors: [],
    requestFailures: [],
    dom: {
      brokenImageCount: 0,
      horizontalOverflowPx: 0,
      performance: {},
    },
  });

  const current = normalizeMonitoringSnapshot("BROWSER_QA", {
    mainStatus: 200,
    durationMs: 320,
    title: "Checkout",
    pageErrors: [{ message: "boom" }],
    consoleErrors: [],
    httpErrors: [],
    requestFailures: [],
    dom: {
      brokenImageCount: 1,
      horizontalOverflowPx: 20,
      performance: {},
    },
  });

  const regressions = compareSnapshots(previous, current);
  assert.ok(regressions.some((item) => item.severity === "HIGH"));
  assert.ok(regressions.some((item) => item.category === "layout"));
});

test("snapshot fingerprint ignores HTTP latency noise", () => {
  const left = {
    kind: "http",
    statusCode: 200,
    latencyMs: 100,
    contentType: "text/html",
    location: null,
  };
  const right = { ...left, latencyMs: 900 };

  assert.equal(snapshotFingerprint(left), snapshotFingerprint(right));
});

test("repair pattern key is stable for the same symptom", () => {
  const finding = {
    id: "finding",
    category: "browser-runtime",
    title: "Runtime error",
    fingerprint: "abc",
    evidence: { message: "Cannot read properties of undefined" },
    verification: { status: "VERIFIED" },
  };

  assert.equal(repairPatternKey(finding), repairPatternKey(finding));

  const learning = extractRepairLearning({
    finding,
    remediationResult: { outcome: "fixed and tested" },
    outcome: "SUCCESS",
  });
  assert.equal(learning.outcome, "SUCCESS");
  assert.equal(learning.successfulStrategy.source, "verified-remediation");
  assert.equal(learning.lessons.rawClientDataStored, false);
  assert.match(learning.symptomSignature, /^sha256:/);
  assert.equal(JSON.stringify(learning).includes("fixed and tested"), false);
});
