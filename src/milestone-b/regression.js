import { createHash } from "node:crypto";

function hash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeMonitoringSnapshot(capability, observation) {
  if (capability === "PUBLIC_HTTP_OBSERVE") {
    return {
      kind: "http",
      statusCode: safeNumber(observation.statusCode),
      latencyMs: safeNumber(observation.latencyMs),
      contentType: observation.headers?.contentType || null,
      location: observation.headers?.location || null,
    };
  }

  return {
    kind: "browser",
    mainStatus: safeNumber(observation.mainStatus),
    durationMs: safeNumber(observation.durationMs),
    title: observation.title || "",
    pageErrorCount: observation.pageErrors?.length || 0,
    consoleErrorCount: observation.consoleErrors?.length || 0,
    httpErrorCount: observation.httpErrors?.length || 0,
    requestFailureCount: observation.requestFailures?.length || 0,
    brokenImageCount: observation.dom?.brokenImageCount || 0,
    horizontalOverflowPx: observation.dom?.horizontalOverflowPx || 0,
    cls: safeNumber(observation.dom?.performance?.cls) || 0,
    longTasks: observation.dom?.performance?.longTasks || 0,
    screenshot: observation.artifact
      ? {
          sha256: observation.artifact.sha256,
          byteLength: observation.artifact.byteLength,
        }
      : null,
  };
}

export function snapshotFingerprint(snapshot) {
  const stable =
    snapshot.kind === "http"
      ? {
          kind: snapshot.kind,
          statusCode: snapshot.statusCode,
          contentType: snapshot.contentType,
          location: snapshot.location,
        }
      : {
          kind: snapshot.kind,
          mainStatus: snapshot.mainStatus,
          title: snapshot.title,
          pageErrorCount: snapshot.pageErrorCount,
          consoleErrorCount: snapshot.consoleErrorCount,
          httpErrorCount: snapshot.httpErrorCount,
          requestFailureCount: snapshot.requestFailureCount,
          brokenImageCount: snapshot.brokenImageCount,
          horizontalOverflowPx: snapshot.horizontalOverflowPx,
        };
  return hash(stable);
}

function severityForStatus(status) {
  return status >= 500 ? "HIGH" : "MEDIUM";
}

export function compareSnapshots(previous, current) {
  if (!previous) return [];

  const regressions = [];

  if (current.kind === "http") {
    if (
      previous.statusCode != null &&
      previous.statusCode < 400 &&
      current.statusCode != null &&
      current.statusCode >= 400
    ) {
      regressions.push({
        signal: "http-status",
        category: "availability",
        severity: severityForStatus(current.statusCode),
        summary: `HTTP status regressed from ${previous.statusCode} to ${current.statusCode}`,
        evidence: { previous, current },
      });
    }

    if (
      previous.latencyMs != null &&
      current.latencyMs != null &&
      current.latencyMs > Math.max(previous.latencyMs * 2, previous.latencyMs + 1000)
    ) {
      regressions.push({
        signal: "http-latency",
        category: "performance",
        severity: "MEDIUM",
        summary: `HTTP latency regressed from ${previous.latencyMs}ms to ${current.latencyMs}ms`,
        evidence: { previous, current },
      });
    }
  } else {
    if (
      previous.mainStatus != null &&
      previous.mainStatus < 400 &&
      current.mainStatus != null &&
      current.mainStatus >= 400
    ) {
      regressions.push({
        signal: "page-status",
        category: "availability",
        severity: severityForStatus(current.mainStatus),
        summary: `Page status regressed from ${previous.mainStatus} to ${current.mainStatus}`,
        evidence: { previous, current },
      });
    }

    for (const key of [
      "pageErrorCount",
      "consoleErrorCount",
      "httpErrorCount",
      "requestFailureCount",
      "brokenImageCount",
    ]) {
      if ((current[key] || 0) > (previous[key] || 0)) {
        regressions.push({
          signal: key,
          category: "reliability",
          severity: key === "pageErrorCount" ? "HIGH" : "MEDIUM",
          summary: `${key} increased from ${previous[key] || 0} to ${current[key] || 0}`,
          evidence: { metric: key, previous: previous[key] || 0, current: current[key] || 0 },
        });
      }
    }

    if (
      previous.durationMs != null &&
      current.durationMs != null &&
      current.durationMs > Math.max(previous.durationMs * 2, previous.durationMs + 1500)
    ) {
      regressions.push({
        signal: "browser-duration",
        category: "performance",
        severity: "MEDIUM",
        summary: `Browser load duration regressed from ${previous.durationMs}ms to ${current.durationMs}ms`,
        evidence: { previousMs: previous.durationMs, currentMs: current.durationMs },
      });
    }

    if ((current.horizontalOverflowPx || 0) > 8 && (previous.horizontalOverflowPx || 0) <= 8) {
      regressions.push({
        signal: "horizontal-overflow",
        category: "layout",
        severity: "LOW",
        summary: "New horizontal overflow detected",
        evidence: {
          previousPx: previous.horizontalOverflowPx || 0,
          currentPx: current.horizontalOverflowPx || 0,
        },
      });
    }
  }

  return regressions.map((item) => ({
    ...item,
    fingerprint: hash([item.category, item.signal || item.summary]),
  }));
}

export function monitoringFailureFingerprint(error) {
  const code = String(error?.code || "MONITOR_FAILED")
    .replace(/[^A-Z0-9_.-]/gi, "_")
    .slice(0, 80);
  return hash(["monitoring-failure", code]);
}
