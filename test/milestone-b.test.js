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
  sanitizeRepairLearning,
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

test("console regressions use stable signal fingerprints", () => {
  const baseObservation = {
    mainStatus: 200,
    durationMs: 300,
    title: "App",
    pageErrors: [],
    httpErrors: [],
    requestFailures: [],
    dom: { brokenImageCount: 0, horizontalOverflowPx: 0, performance: {} },
  };
  const baseline = normalizeMonitoringSnapshot("BROWSER_QA", {
    ...baseObservation,
    consoleErrors: [],
  });
  const one = normalizeMonitoringSnapshot("BROWSER_QA", {
    ...baseObservation,
    consoleErrors: [{ text: "first" }],
  });
  const two = normalizeMonitoringSnapshot("BROWSER_QA", {
    ...baseObservation,
    consoleErrors: [{ text: "first" }, { text: "second" }],
  });

  const first = compareSnapshots(baseline, one)
    .find((item) => item.signal === "consoleErrorCount");
  const second = compareSnapshots(baseline, two)
    .find((item) => item.signal === "consoleErrorCount");
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.fingerprint, second.fingerprint);
});

test("repair learning drops raw keys, paths, errors, source and credentials", () => {
  const finding = {
    category: "browser-runtime",
    rootCauseKey: "C:\\private-client\\src\\secret.js",
    title: "private failure",
    fingerprint: "private-fingerprint",
    evidence: { errorText: "https://client.example/private?token=secret" },
    verification: { status: "VERIFIED", evidence: { matched: true } },
  };
  const extracted = extractRepairLearning({
    finding,
    remediationResult: {
      "C:\\private-client\\src\\secret.js": "source code",
      "API_KEY_SUPER_SECRET": "credential-value",
    },
    outcome: "SUCCESS",
  });
  const serialized = JSON.stringify(extracted);
  assert.equal(serialized.includes("private-client"), false);
  assert.equal(serialized.includes("API_KEY_SUPER_SECRET"), false);
  assert.equal(serialized.includes("credential-value"), false);
  assert.equal(extracted.successfulStrategy.resultShape.keyCount, 2);

  const sanitized = sanitizeRepairLearning({
    finding,
    learning: {
      outcome: "SUCCESS",
      successfulStrategy: {
        resultType: "object",
        resultShape: { keyCount: 7, itemCount: 0 },
        sourceCode: "do not persist this",
      },
      lessons: { password: "hunter2" },
    },
  });
  const safe = JSON.stringify(sanitized);
  assert.equal(safe.includes("do not persist this"), false);
  assert.equal(safe.includes("hunter2"), false);
  assert.equal(sanitized.successfulStrategy.resultShape.keyCount, 7);
});
