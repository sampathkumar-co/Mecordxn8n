import http from "node:http";
import { timingSafeEqual } from "node:crypto";

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

export function createTriggeredWorkerService({
  triggerToken,
  runOnce,
  health = async () => ({ ok: true }),
}) {
  if (!triggerToken) throw new Error("WORKER_TRIGGER_TOKEN is required");
  if (typeof runOnce !== "function") throw new Error("runOnce is required");

  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      try {
        return respond(res, 200, await health());
      } catch (error) {
        return respond(res, 503, {
          ok: false,
          error: error.code || "HEALTHCHECK_FAILED",
        });
      }
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
      return respond(res, 200, await runOnce());
    } catch (error) {
      return respond(res, 502, {
        error: error.code || "WORKER_FAILED",
        message: error.message,
      });
    }
  });
}
