import test from "node:test";
import assert from "node:assert/strict";

import {
  assertBrowserRequestAllowed,
  buildBrowserFindings,
} from "../src/workers/browser-qa.js";

test("browser policy blocks non-read methods", async () => {
  await assert.rejects(
    () =>
      assertBrowserRequestAllowed("https://example.com/api", "POST", {
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      }),
    (error) => error.code === "BROWSER_METHOD_BLOCKED",
  );
});

test("browser policy blocks private/reserved destinations", async () => {
  await assert.rejects(
    () =>
      assertBrowserRequestAllowed("http://internal.example/", "GET", {
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
    (error) => error.code === "BROWSER_PUBLIC_ADDRESS_REQUIRED",
  );
});

test("browser policy allows read-only requests to public addresses", async () => {
  await assert.doesNotReject(() =>
    assertBrowserRequestAllowed("https://example.com/app.js", "GET", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    }),
  );
});

test("browser findings keep same-site failures and deduplicate repeated signals", () => {
  const observation = {
    requestedUrl: "https://example.com/checkout",
    finalUrl: "https://example.com/checkout",
    viewport: "mobile",
    pageErrors: [
      { name: "TypeError", message: "Cannot read properties of undefined" },
      { name: "TypeError", message: "Cannot read properties of undefined" },
    ],
    consoleErrors: [{ text: "Failed to hydrate component" }],
    httpErrors: [
      {
        url: "https://example.com/api/cart",
        status: 500,
        resourceType: "fetch",
      },
      {
        url: "https://cdn.example.net/image.png",
        status: 404,
        resourceType: "image",
      },
    ],
    requestFailures: [],
    dom: {
      brokenImageCount: 0,
      brokenImages: [],
      horizontalOverflowPx: 0,
    },
  };

  const findings = buildBrowserFindings(observation);
  assert.equal(findings.length, 3);

  const runtime = findings.find((item) => item.category === "browser-runtime");
  assert.equal(runtime.severity, "MEDIUM");

  const network = findings.find(
    (item) => item.category === "browser-network" && item.evidence.status === 500,
  );
  assert.equal(network.severity, "MEDIUM");

  assert.equal(
    findings.some(
      (item) => item.affectedUrl === "https://cdn.example.net/image.png",
    ),
    false,
  );
});

test("rendering evidence creates bounded broken-image and overflow findings", () => {
  const observation = {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    viewport: "mobile",
    pageErrors: [],
    consoleErrors: [],
    httpErrors: [],
    requestFailures: [],
    artifact: {
      type: "screenshot",
      path: "/artifacts/test-mobile.png",
      sha256: "a".repeat(64),
      byteLength: 1234,
    },
    dom: {
      brokenImageCount: 2,
      brokenImages: [
        { src: "https://example.com/a.png", alt: "A" },
        { src: "https://example.com/b.png", alt: "B" },
      ],
      horizontalOverflowPx: 37,
    },
  };

  const findings = buildBrowserFindings(observation);
  assert.equal(findings.length, 2);
  assert.ok(
    findings.some((item) => item.category === "browser-rendering"),
  );
  assert.ok(findings.some((item) => item.category === "browser-layout"));
  assert.ok(
    findings.every(
      (item) => item.evidence.screenshot?.sha256 === "a".repeat(64),
    ),
  );
});

test("browser evidence text is bounded", () => {
  const observation = {
    requestedUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    viewport: "desktop",
    pageErrors: [],
    consoleErrors: [{ text: "x".repeat(5000) }],
    httpErrors: [],
    requestFailures: [],
    dom: {
      brokenImageCount: 0,
      brokenImages: [],
      horizontalOverflowPx: 0,
    },
  };

  const [finding] = buildBrowserFindings(observation);
  assert.ok(finding.evidence.message.length < 800);
});
