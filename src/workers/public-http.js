import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash } from "node:crypto";

import { CAPABILITIES } from "../authorization.js";
import {
  completeJob,
  leaseJob,
  recordFinding,
} from "./control-client.js";

const DEFAULT_USER_AGENT = "Mecordxn8n-Public-QA/0.1";

function isPrivateOrReservedIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateOrReservedIPv6(address) {
  const normalized = address.toLowerCase();
  if (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true;
  }

  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateOrReservedIPv4(mapped[1]) : false;
}

export function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return !isPrivateOrReservedIPv4(address);
  if (version === 6) return !isPrivateOrReservedIPv6(address);
  return false;
}

export async function resolvePublicAddress(hostname, lookup = dns.lookup) {
  const results = await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error("DNS resolution returned no addresses");
  }

  if (results.some((entry) => !isPublicAddress(entry.address))) {
    const error = new Error("hostname resolves to a non-public address");
    error.code = "PUBLIC_ADDRESS_REQUIRED";
    throw error;
  }

  return results[0];
}

export async function observePublicHttpUrl(
  rawUrl,
  {
    timeoutMs = 10_000,
    userAgent = DEFAULT_USER_AGENT,
    lookup = dns.lookup,
  } = {},
) {
  const url = new URL(rawUrl);

  if (!["http:", "https:"].includes(url.protocol)) {
    const error = new Error("only HTTP(S) URLs are supported");
    error.code = "UNSUPPORTED_PROTOCOL";
    throw error;
  }

  const defaultPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== defaultPort) {
    const error = new Error("non-standard ports are not allowed for public observation");
    error.code = "PORT_NOT_ALLOWED";
    throw error;
  }

  const resolved = await resolvePublicAddress(url.hostname, lookup);
  const transport = url.protocol === "https:" ? https : http;
  const started = performance.now();

  return await new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: resolved.address,
        port: Number(defaultPort),
        method: "GET",
        path: `${url.pathname}${url.search}`,
        servername: url.hostname,
        headers: {
          Host: url.host,
          "User-Agent": userAgent,
          Accept: "*/*",
          Connection: "close",
        },
        timeout: timeoutMs,
        rejectUnauthorized: true,
      },
      (response) => {
        const latencyMs = Math.round(performance.now() - started);
        const result = {
          url: url.toString(),
          statusCode: response.statusCode || 0,
          latencyMs,
          remoteAddress: resolved.address,
          headers: {
            contentType: response.headers["content-type"] || null,
            contentLength: response.headers["content-length"] || null,
            location: response.headers.location || null,
          },
          redirectFollowed: false,
        };

        response.destroy();
        resolve(result);
      },
    );

    request.on("timeout", () => {
      request.destroy(Object.assign(new Error("request timed out"), { code: "HTTP_TIMEOUT" }));
    });
    request.on("error", reject);
    request.end();
  });
}

function fingerprint(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function findingForObservation(observation) {
  if (observation.statusCode < 400) return null;

  const url = new URL(observation.url);
  return {
    fingerprint: fingerprint([
      "http-status",
      url.hostname,
      url.pathname,
      String(observation.statusCode),
    ]),
    category: "http-status",
    title: `HTTP ${observation.statusCode} on public page`,
    severity: observation.statusCode >= 500 ? "MEDIUM" : "LOW",
    confidence: 0.99,
    affectedUrl: observation.url,
    evidence: observation,
  };
}

export async function runPublicHttpObserverOnce({
  controlApiUrl,
  workerToken,
  workerId = "public-http-observer",
  observe = observePublicHttpUrl,
}) {
  const job = await leaseJob({
    controlApiUrl,
    workerToken,
    workerId,
    capabilities: [CAPABILITIES.PUBLIC_HTTP_OBSERVE],
    leaseSeconds: 60,
  });

  if (!job) return { state: "IDLE" };

  try {
    const observation = await observe(job.requestedUrl);
    const finding = findingForObservation(observation);

    if (finding) {
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
        findingRecorded: Boolean(finding),
      },
    });

    return {
      state: "PROCESSED",
      jobId: job.id,
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
          code: error.code || "OBSERVATION_FAILED",
          message: error.message,
        },
      });
    } catch {
      // A lost/expired lease must not be force-completed by this worker.
    }
    throw error;
  }
}
