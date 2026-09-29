import dns from "node:dns/promises";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { CAPABILITIES } from "../authorization.js";
import {
  completeJob,
  leaseJob,
  recordFinding,
} from "./control-client.js";
import { isPublicAddress } from "./public-http.js";
import {
  closeSafeEgressProxy,
  createSafeEgressProxy,
  listenSafeEgressProxy,
} from "./safe-egress-proxy.js";

const MAX_EVENTS = 30;
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
    return (
      new URL(targetUrl).hostname.toLowerCase() ===
      new URL(candidateUrl).hostname.toLowerCase()
    );
  } catch {
    return false;
  }
}

function originKey(rawUrl) {
  const url = new URL(rawUrl);
  return {
    protocol: url.protocol,
    hostname: url.hostname.toLowerCase(),
    port:
      url.port ||
      (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : ""),
  };
}

function sameOrigin(left, right) {
  return (
    left.protocol === right.protocol &&
    left.hostname === right.hostname &&
    left.port === right.port
  );
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

function domFindings(observation) {
  const findings = [];
  const pageUrl = observation.finalUrl || observation.requestedUrl;

  if (observation.dom?.brokenImageCount > 0) {
    findings.push({
      fingerprint: hash([
        "browser-broken-images",
        pageUrl,
        JSON.stringify(observation.dom.brokenImages || []),
      ]),
      category: "browser-rendering",
      title: "Rendered page contains broken images",
      severity: "LOW",
      confidence: 0.96,
      affectedUrl: pageUrl,
      evidence: {
        brokenImageCount: observation.dom.brokenImageCount,
        samples: observation.dom.brokenImages,
        viewport: observation.viewport,
        screenshot: observation.artifact || null,
      },
    });
  }

  if (observation.dom?.horizontalOverflowPx > 8) {
    findings.push({
      fingerprint: hash([
        "browser-horizontal-overflow",
        pageUrl,
        observation.viewport,
        String(observation.dom.horizontalOverflowPx),
      ]),
      category: "browser-layout",
      title: "Page overflows horizontally at the tested viewport",
      severity: "LOW",
      confidence: 0.9,
      affectedUrl: pageUrl,
      evidence: {
        horizontalOverflowPx: observation.dom.horizontalOverflowPx,
        viewport: observation.viewport,
        screenshot: observation.artifact || null,
      },
    });
  }

  return findings;
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
        screenshot: observation.artifact || null,
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
        location: event.location || null,
        viewport: observation.viewport,
        screenshot: observation.artifact || null,
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

  findings.push(...domFindings(observation));

  const unique = new Map();
  for (const finding of findings) {
    if (!unique.has(finding.fingerprint)) {
      unique.set(finding.fingerprint, finding);
    }
  }

  return [...unique.values()].slice(0, MAX_EVENTS);
}

async function collectDomEvidence(page) {
  return page.evaluate(() => {
    const broken = [...document.images].filter(
      (image) => image.complete && image.naturalWidth === 0,
    );

    const root = document.documentElement;
    const viewportWidth = root.clientWidth || window.innerWidth || 0;
    const navigation = performance.getEntriesByType("navigation")[0];

    return {
      brokenImageCount: broken.length,
      brokenImages: broken.slice(0, 10).map((image) => ({
        src: image.currentSrc || image.src || "",
        alt: image.alt || "",
      })),
      horizontalOverflowPx: Math.max(
        0,
        (root.scrollWidth || 0) - viewportWidth,
      ),
      linkCount: document.links.length,
      formCount: document.forms.length,
      performance: {
        domContentLoadedMs: navigation?.domContentLoadedEventEnd || null,
        loadEventMs: navigation?.loadEventEnd || null,
        transferSize: navigation?.transferSize || null,
        cls: globalThis.__mecordQa?.cls || 0,
        longTasks: globalThis.__mecordQa?.longTasks || 0,
        longTaskDurationMs:
          globalThis.__mecordQa?.longTaskDurationMs || 0,
      },
    };
  });
}

export async function auditBrowserPage(
  requestedUrl,
  {
    viewport = "desktop",
    timeoutMs = 15_000,
    lookup = dns.lookup,
    browserFactory,
    artifactDir = process.env.ARTIFACT_DIR || "/artifacts",
    artifactName = "browser-qa",
    captureScreenshot = true,
    proxyFactory = () => createSafeEgressProxy({ lookup }),
  } = {},
) {
  const dnsCache = new Map();
  await assertBrowserRequestAllowed(requestedUrl, "GET", { lookup, dnsCache });

  const requestedOrigin = originKey(requestedUrl);
  const proxy = proxyFactory();
  const proxyServer = await listenSafeEgressProxy(proxy);
  let browser;

  try {
    const factory =
      browserFactory ||
      (async ({ proxyServer: configuredProxy }) => {
        const { chromium } = await import("playwright");
        return chromium.launch({
          headless: true,
          proxy: { server: configuredProxy },
          args: [
            "--proxy-bypass-list=<-loopback>",
            "--disable-dev-shm-usage",
            "--disable-background-networking",
            "--disable-sync",
            "--no-first-run",
          ],
        });
      });

    browser = await factory({ proxyServer });

    const viewportSize =
      viewport === "mobile"
        ? { width: 390, height: 844 }
        : { width: 1440, height: 900 };

    const context = await browser.newContext({
      viewport: viewportSize,
      javaScriptEnabled: true,
      serviceWorkers: "block",
      ignoreHTTPSErrors: false,
      acceptDownloads: false,
    });

    await context.addInitScript(() => {
      globalThis.__mecordQa = {
        cls: 0,
        longTasks: 0,
        longTaskDurationMs: 0,
      };

      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) {
              globalThis.__mecordQa.cls += entry.value;
            }
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {}

      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            globalThis.__mecordQa.longTasks += 1;
            globalThis.__mecordQa.longTaskDurationMs += entry.duration;
          }
        }).observe({ type: "longtask", buffered: true });
      } catch {}
    });

    const page = await context.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    const httpErrors = [];
    const requestFailures = [];
    const blockedMutations = [];
    const blockedOutOfScopeNavigations = [];

    context.on("page", (candidate) => {
      if (candidate !== page) {
        void candidate.close().catch(() => {});
      }
    });

    page.on("console", (message) => {
      if (message.type() === "error" && consoleErrors.length < MAX_EVENTS) {
        consoleErrors.push({
          text: compactText(message.text()),
          location: message.location(),
        });
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
      const errorText = compactText(
        request.failure()?.errorText || "request failed",
      );

      if (errorText.includes("ERR_BLOCKED_BY_CLIENT")) return;

      if (requestFailures.length < MAX_EVENTS) {
        requestFailures.push({
          url: request.url(),
          resourceType: request.resourceType(),
          errorText,
        });
      }
    });

    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method().toUpperCase();

      if (!READ_ONLY_METHODS.has(method)) {
        if (blockedMutations.length < MAX_EVENTS) {
          blockedMutations.push({
            method,
            resourceType: request.resourceType(),
            url: compactText(request.url(), 500),
          });
        }
        return route.abort("blockedbyclient");
      }

      if (
        request.isNavigationRequest() &&
        request.frame() === page.mainFrame()
      ) {
        try {
          if (!sameOrigin(requestedOrigin, originKey(request.url()))) {
            if (blockedOutOfScopeNavigations.length < MAX_EVENTS) {
              blockedOutOfScopeNavigations.push({
                from: requestedUrl,
                to: compactText(request.url(), 500),
              });
            }
            return route.abort("blockedbyclient");
          }
        } catch {
          return route.abort("blockedbyclient");
        }
      }

      return route.continue();
    });

    const started = performance.now();

    try {
      const mainResponse = await page.goto(requestedUrl, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(Math.max(Number(timeoutMs) || 15_000, 5_000), 20_000),
      });

      await page.waitForLoadState("load", {
        timeout: 5_000,
      }).catch(() => {});

      await page.waitForTimeout(750);

      const finalUrl = page.url();
      if (!sameOrigin(requestedOrigin, originKey(finalUrl))) {
        const error = new Error(
          "browser navigation redirected outside the authorized origin",
        );
        error.code = "BROWSER_REDIRECT_OUT_OF_SCOPE";
        throw error;
      }

      const dom = await collectDomEvidence(page);

      let artifact = null;
      if (captureScreenshot) {
        await fs.mkdir(artifactDir, { recursive: true });
        const safeName = String(artifactName)
          .replace(/[^a-z0-9_-]+/gi, "-")
          .slice(0, 80);
        const screenshotPath = path.join(
          artifactDir,
          `${safeName}-${viewport}.png`,
        );
        const bytes = await page.screenshot({
          path: screenshotPath,
          fullPage: false,
          animations: "disabled",
        });
        artifact = {
          type: "screenshot",
          path: screenshotPath,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.length,
        };
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
        blockedMutations,
        blockedOutOfScopeNavigations,
        dom,
        artifact,
      };
    } finally {
      await context.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    await closeSafeEgressProxy(proxy).catch(() => {});
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
    leaseSeconds: 300,
  });

  if (!job) return { state: "IDLE" };

  try {
    const viewport = job.input?.viewport === "mobile" ? "mobile" : "desktop";
    const observation = await audit(job.requestedUrl, {
      viewport,
      artifactName: job.id,
      captureScreenshot: job.input?.captureScreenshot !== false,
    });
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
