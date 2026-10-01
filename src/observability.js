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
