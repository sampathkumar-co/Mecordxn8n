import { randomUUID } from "node:crypto";

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export function requestIdFrom(req) {
  const supplied = String(req.headers["x-request-id"] || "").trim();
  return SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
}

export function writeLog(level, event, fields = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

export function attachRequestLogging(req, res, pathname) {
  const requestId = requestIdFrom(req);
  const started = performance.now();
  res.mecordRequestId = requestId;
  res.setHeader("x-request-id", requestId);

  res.once("finish", () => {
    writeLog(
      res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARN" : "INFO",
      "http_request",
      {
        requestId,
        method: String(req.method || "GET").slice(0, 12),
        path: String(pathname || "/").slice(0, 500),
        status: res.statusCode,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
      },
    );
    observeRequest({
      method: req.method,
      pathname,
      status: res.statusCode,
      durationMs: Math.max(0, performance.now() - started),
    });
  });
  return requestId;
}

export function logUnhandledRequestError(error, req, res, pathname) {
  writeLog("ERROR", "http_request_error", {
    requestId: res.mecordRequestId || null,
    method: String(req.method || "GET").slice(0, 12),
    path: String(pathname || "/").slice(0, 500),
    code: String(error?.code || "INTERNAL_ERROR").slice(0, 120),
    errorName: String(error?.name || "Error").slice(0, 120),
  });
}

const HTTP_TOTAL = new Map();
const HTTP_DURATION_SUM = new Map();
const HTTP_DURATION_COUNT = new Map();
const HTTP_DURATION_BUCKETS = [0.01,0.05,0.1,0.25,0.5,1,2.5,5,10];
const HTTP_BUCKET_COUNTS = new Map();

function metricRoute(pathname) {
  return String(pathname || "/")
    .replace(
      /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi,
      "/:id",
    )
    .replace(
      /^\/v1\/platform\/public\/reports\/[^/]+$/i,
      "/v1/platform/public/reports/:token",
    )
    .slice(0, 240);
}

function labels(method, route, statusClass) {
  return JSON.stringify([method, route, statusClass]);
}

function observeRequest({ method, pathname, status, durationMs }) {
  const route = metricRoute(pathname);
  const verb = String(method || "GET").slice(0, 12).toUpperCase();
  const statusClass = Math.floor(Number(status || 0) / 100) + "xx";
  const key = labels(verb, route, statusClass);
  HTTP_TOTAL.set(key, (HTTP_TOTAL.get(key) || 0) + 1);

  const routeKey = JSON.stringify([verb, route]);
  const seconds = Math.max(0, Number(durationMs || 0)) / 1000;
  HTTP_DURATION_SUM.set(
    routeKey,
    (HTTP_DURATION_SUM.get(routeKey) || 0) + seconds,
  );
  HTTP_DURATION_COUNT.set(
    routeKey,
    (HTTP_DURATION_COUNT.get(routeKey) || 0) + 1,
  );
  for (const bucket of HTTP_DURATION_BUCKETS) {
    const bucketKey = JSON.stringify([verb, route, bucket]);
    if (seconds <= bucket) {
      HTTP_BUCKET_COUNTS.set(
        bucketKey,
        (HTTP_BUCKET_COUNTS.get(bucketKey) || 0) + 1,
      );
    }
  }
}

function promEscape(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

export function renderPrometheusMetrics() {
  const lines = [
    "# HELP mecord_http_requests_total HTTP requests by normalized route and status class.",
    "# TYPE mecord_http_requests_total counter",
  ];
  for (const [key, value] of [...HTTP_TOTAL.entries()].sort()) {
    const [method, route, statusClass] = JSON.parse(key);
    lines.push(
      `mecord_http_requests_total{method="${promEscape(method)}",route="${promEscape(route)}",status_class="${promEscape(statusClass)}"} ${value}`,
    );
  }

  lines.push(
    "# HELP mecord_http_request_duration_seconds HTTP request duration.",
    "# TYPE mecord_http_request_duration_seconds histogram",
  );
  for (const [routeKey, count] of [...HTTP_DURATION_COUNT.entries()].sort()) {
    const [method, route] = JSON.parse(routeKey);
    for (const bucket of HTTP_DURATION_BUCKETS) {
      const bucketKey = JSON.stringify([method, route, bucket]);
      lines.push(
        `mecord_http_request_duration_seconds_bucket{method="${promEscape(method)}",route="${promEscape(route)}",le="${bucket}"} ${HTTP_BUCKET_COUNTS.get(bucketKey) || 0}`,
      );
    }
    lines.push(
      `mecord_http_request_duration_seconds_bucket{method="${promEscape(method)}",route="${promEscape(route)}",le="+Inf"} ${count}`,
    );
    lines.push(
      `mecord_http_request_duration_seconds_sum{method="${promEscape(method)}",route="${promEscape(route)}"} ${HTTP_DURATION_SUM.get(routeKey) || 0}`,
    );
    lines.push(
      `mecord_http_request_duration_seconds_count{method="${promEscape(method)}",route="${promEscape(route)}"} ${count}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
