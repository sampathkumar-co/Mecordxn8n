import dns from "node:dns/promises";
import { createHash } from "node:crypto";

import { CAPABILITIES } from "../authorization.js";
import {
  completeJob,
  leaseJob,
  recordFinding,
} from "./control-client.js";
import { isPublicAddress } from "./public-http.js";

const MAX_EVENTS = 25;
const MAX_TEXT = 700;
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function compactText(value, limit = MAX_TEXT) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function hash(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function sameSiteHost(targetUrl, candidateUrl) {
  try {
    return new URL(targetUrl).hostname.toLowerCase() ===
      new URL(candidateUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
}

export async function assertBrowserRequestAllowed(
  requestUrl,
  method,
  {
    lookup = dns.lookup,
    dnsCache = new Map(),
  } = {},
) {
  if (!READ_ONLY_METHODS.has(String(method || "").toUpperCase())) {
    const error = new Error("browser QA blocks non-read HTTP methods");
    error.code = "BROWSER_METHOD_BLOCKED";
    throw error;
  }

  const url = new URL(requestUrl);
  if (!["http:", "https:"].includes(url.protocol)) {
    const error = new Error("browser QA only allows HTTP(S) requests");
    error.code = "BROWSER_PROTOCOL_BLOCKED";
    throw error;
  }

  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== defaultPort) {
    const error = new Error("browser QA blocks non-standard ports");
    error.code = "BROWSER_PORT_BLOCKED";
    throw error;
  }

  let addresses = dnsCache.get(url.hostname);
  if (!addresses) {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || addresses.length === 0) {
      const error = new Error("browser request hostname did not resolve");
      error.code = "BROWSER_DNS_EMPTY";
      throw error;
    }
    dnsCache.set(url.hostname, addresses);
  }

  if (addresses.some((entry) => !isPublicAddress(entry.address))) {
    const error = new Error("browser request resolves to a non-public address");
    error.code = "BROWSER_PUBLIC_ADDRESS_REQUIRED";
    throw error;
  }

  return true;
}

export function buildBrowserFindings(observation) {
  const findings = [];
  const targetUrl = observation.requestedUrl;

  for (const event of observation.pageErrors || []) {
    const message = compactText(event.message);
    findings.push({
      fingerprint: hash([
        "browser-page-error",
        new URL(targetUrl).hostname,
        message,
      ]),
      category: "browser-runtime",
      title: "Browser runtime error",
      severity: "MEDIUM",
      confidence: 0.96,
      affectedUrl: observation.finalUrl || targetUrl,
      evidence: {
        message,
        name: compactText(event.name || "Error", 120),
        viewport: observation.viewport,
      },
    });
  }

  for (const event of observation.consoleErrors || []) {
    const message = compactText(event.text);
    findings.push({
      fingerprint: hash([
        "browser-console-error",
        new URL(targetUrl).hostname,
        message,
      ]),
      category: "browser-console",
      title: "Console error on public page",
      severity: "LOW",
      confidence: 0.9,
      affectedUrl: observation.finalUrl || targetUrl,
      evidence: {
        message,
        viewport: observation.viewport,
      },
    });
  }

  for (const event of observation.httpErrors || []) {
    if (!sameSiteHost(targetUrl, event.url)) continue;

    const parsed = new URL(event.url);
    findings.push({
      fingerprint: hash([
        "browser-http-status",
        parsed.hostname,
        parsed.pathname,
        String(event.status),
      ]),
      category: "browser-network",
      title: `HTTP ${event.status} while loading page`,
      severity: event.status >= 500 ? "MEDIUM" : "LOW",
      confidence: 0.98,
      affectedUrl: event.url,
      evidence: {
        status: event.status,
        resourceType: event.resourceType,
        viewport: observation.viewport,
      },
    });
  }

  for (const event of observation.requestFailures || []) {
    if (!sameSiteHost(targetUrl, event.url)) continue;

    const parsed = new URL(event.url);
    findings.push({
      fingerprint: hash([
        "browser-request-failure",
        parsed.hostname,
        parsed.pathname,
        compactText(event.errorText, 160),
      ]),
      category: "browser-network",
      title: "Network request failed while loading page",
      severity: "LOW",
      confidence: 0.92,
      affectedUrl: event.url,
      evidence: {
        errorText: compactText(event.errorText),
        resourceType: event.resourceType,
        viewport: observation.viewport,
      },
    });
  }

  const unique = new Map();
  for (const finding of findings) {
    if (!unique.has(finding.fingerprint)) {
      unique.set(finding.fingerprint, finding);
    }
  }

  return [...unique.values()].slice(0, MAX_EVENTS);
}

export async function auditBrowserPage(
  requestedUrl,
  {
    viewport = "desktop",
    timeoutMs = 15_000,
    lookup = dns.lookup,
    browserFactory,
  } = {},
) {
  const dnsCache = new Map();
  await assertBrowserRequestAllowed(requestedUrl, "GET", { lookup, dnsCache });

  const factory =
    browserFactory ||
    (async () => {
      const { chromium } = await import("playwright");
      return chromium.launch({
        headless: true,
        args: [
          "--disable-dev-shm-usage",
          "--disable-background-networking",
          "--disable-sync",
          "--no-first-run",
        ],
      });
    });

  const browser = await factory();
  const viewportSize =
    viewport === "mobile"
      ? { width: 390, height: 844 }
      : { width: 1440, height: 900 };

  const context = await browser.newContext({
    viewport: viewportSize,
    javaScriptEnabled: true,
    serviceWorkers: "block",
    ignoreHTTPSErrors: false,
  });

  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const httpErrors = [];
  const requestFailures = [];
  let blockedRequests = 0;

  page.on("console", (message) => {
    if (message.type() === "error" && consoleErrors.length < MAX_EVENTS) {
      consoleErrors.push({ text: compactText(message.text()) });
    }
  });

  page.on("pageerror", (error) => {
    if (pageErrors.length < MAX_EVENTS) {
      pageErrors.push({
        name: compactText(error.name, 120),
        message: compactText(error.message),
      });
    }
  });

  page.on("response", (response) => {
    if (response.status() >= 400 && httpErrors.length < MAX_EVENTS) {
      httpErrors.push({
        url: response.url(),
        status: response.status(),
        resourceType: response.request().resourceType(),
      });
    }
  });

  page.on("requestfailed", (request) => {
    if (requestFailures.length < MAX_EVENTS) {
      requestFailures.push({
        url: request.url(),
        resourceType: request.resourceType(),
        errorText: compactText(request.failure()?.errorText || "request failed"),
      });
    }
  });

  await page.route("**/*", async (route) => {
    const request = route.request();

    try {
      await assertBrowserRequestAllowed(request.url(), request.method(), {
        lookup,
        dnsCache,
      });
      await route.continue();
    } catch {
      blockedRequests += 1;
      await route.abort("blockedbyclient");
    }
  });

  const started = performance.now();

  try {
    const mainResponse = await page.goto(requestedUrl, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    // Surface initial hydration/runtime problems without interacting with the page.
    await page.waitForTimeout(750);

    const finalUrl = page.url();
    const requestedHost = new URL(requestedUrl).hostname.toLowerCase();
    const finalHost = new URL(finalUrl).hostname.toLowerCase();

    if (finalHost !== requestedHost) {
      const error = new Error(
        "browser navigation redirected outside the authorized host",
      );
      error.code = "BROWSER_REDIRECT_OUT_OF_SCOPE";
      throw error;
    }

    return {
      requestedUrl,
      finalUrl,
      viewport,
      durationMs: Math.round(performance.now() - started),
      mainStatus: mainResponse?.status() || null,
      title: compactText(await page.title(), 240),
      consoleErrors,
      pageErrors,
      httpErrors,
      requestFailures,
      blockedRequests,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

export async function runBrowserQaOnce({
  controlApiUrl,
  workerToken,
  workerId = "browser-qa-worker",
  audit = auditBrowserPage,
}) {
  const job = await leaseJob({
    controlApiUrl,
    workerToken,
    workerId,
    capabilities: [CAPABILITIES.BROWSER_QA],
    leaseSeconds: 120,
  });

  if (!job) return { state: "IDLE" };

  try {
    const viewport = job.input?.viewport === "mobile" ? "mobile" : "desktop";
    const observation = await audit(job.requestedUrl, { viewport });
    const findings = buildBrowserFindings(observation);

    for (const finding of findings) {
      await recordFinding({
        controlApiUrl,
        workerToken,
        workerId,
        jobId: job.id,
        finding,
      });
    }

    const completed = await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "SUCCEEDED",
      output: {
        observation,
        findingsRecorded: findings.length,
      },
    });

    return {
      state: "PROCESSED",
      jobId: job.id,
      findingsRecorded: findings.length,
      job: completed,
    };
  } catch (error) {
    try {
      await completeJob({
        controlApiUrl,
        workerToken,
        workerId,
        jobId: job.id,
        state: "FAILED",
        error: {
          code: error.code || "BROWSER_QA_FAILED",
          message: compactText(error.message),
        },
      });
    } catch {
      // Never force completion after lease loss/expiry.
    }

    throw error;
  }
}
