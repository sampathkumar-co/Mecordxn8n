import http from "node:http";
import { timingSafeEqual } from "node:crypto";

import { runPublicHttpObserverOnce } from "./public-http.js";

function tokenEqual(actual, expected) {
  const a = Buffer.from(actual || "");
  const b = Buffer.from(expected || "");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function respond(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function createObserverService({
  controlApiUrl = process.env.MECORDXN8N_CONTROL_API_URL,
  workerToken = process.env.WORKER_TOKEN,
  triggerToken = process.env.WORKER_TRIGGER_TOKEN,
  workerId = process.env.WORKER_ID || "public-http-observer",
} = {}) {
  if (!controlApiUrl) throw new Error("MECORDXN8N_CONTROL_API_URL is required");
  if (!workerToken) throw new Error("WORKER_TOKEN is required");
  if (!triggerToken) throw new Error("WORKER_TRIGGER_TOKEN is required");

  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      return respond(res, 200, { ok: true });
    }

    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!tokenEqual(token, triggerToken)) {
      return respond(res, 401, { error: "UNAUTHORIZED" });
    }

    if (req.method !== "POST" || req.url !== "/run-once") {
      return respond(res, 404, { error: "NOT_FOUND" });
    }

    try {
      const result = await runPublicHttpObserverOnce({
        controlApiUrl,
        workerToken,
        workerId,
      });
      return respond(res, 200, result);
    } catch (error) {
      return respond(res, 502, {
        error: error.code || "WORKER_FAILED",
        message: error.message,
      });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.WORKER_PORT || 8090);
  const server = createObserverService();
  server.listen(port, () => {
    console.log(`public HTTP observer listening on :${port}`);
  });
}
