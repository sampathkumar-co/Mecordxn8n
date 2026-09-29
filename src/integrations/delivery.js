import https from "node:https";
import { createHmac } from "node:crypto";

import { resolvePublicAddress } from "../workers/public-http.js";

function deliveryError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function fetchJson(url, options, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw deliveryError(
      `HTTP_${response.status}`,
      `provider returned HTTP ${response.status}`,
    );
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 4096) };
  }
}

async function safeWebhookPost({
  url,
  body,
  headers,
  lookup,
  timeoutMs = 15_000,
}) {
  const target = new URL(url);
  if (target.protocol !== "https:" || target.port) {
    throw deliveryError(
      "WEBHOOK_DESTINATION_INVALID",
      "webhook must use HTTPS on the standard port",
    );
  }
  const resolved = await resolvePublicAddress(target.hostname, lookup);
  const payload = Buffer.from(body, "utf8");

  return await new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: resolved.address,
        port: 443,
        servername: target.hostname,
        method: "POST",
        path: `${target.pathname}${target.search}`,
        headers: {
          Host: target.host,
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          "User-Agent": "Mecordxn8n-Integration/1.0",
          Connection: "close",
          ...headers,
        },
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      (response) => {
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size <= 64 * 1024) chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              deliveryError(
                `HTTP_${response.statusCode || 0}`,
                "webhook delivery failed",
              ),
            );
            return;
          }
          resolve({
            statusCode: response.statusCode,
            remoteAddress: resolved.address,
            response:
              size <= 64 * 1024
                ? Buffer.concat(chunks).toString("utf8")
                : "",
          });
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(
        deliveryError("DELIVERY_TIMEOUT", "integration delivery timed out"),
      ),
    );
    request.on("error", reject);
    request.end(payload);
  });
}

function eventTitle(eventType) {
  const labels = {
    "finding.verified": "Verified engineering finding",
    "approval.pending": "Approval requires review",
    "regression.opened": "Monitoring regression detected",
    "remediation.succeeded": "Authorized remediation succeeded",
    "revenue.received": "Revenue received",
    "service.renewal_due": "Service renewal due",
    "system.test": "Mecordxn8n integration test",
  };
  return labels[eventType] || "Mecordxn8n event";
}

function eventEnvelope(delivery) {
  return {
    id: delivery.id,
    eventType: delivery.eventType,
    occurredAt: new Date().toISOString(),
    workspaceId: delivery.workspaceId,
    payload: delivery.payload || {},
  };
}

export async function deliverIntegrationEvent(
  delivery,
  { fetchImpl = fetch, lookup } = {},
) {
  const envelope = eventEnvelope(delivery);
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized) > 128 * 1024) {
    throw deliveryError("PAYLOAD_TOO_LARGE", "integration payload is too large");
  }

  if (delivery.provider === "GITHUB") {
    const { token, owner, repo } = delivery.config;
    const result = await fetchJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "Mecordxn8n-Integration/1.0",
        },
        body: JSON.stringify({
          title: `[Mecordxn8n] ${eventTitle(delivery.eventType)}`.slice(0, 240),
          body: [
            "This issue was created from an approved Mecordxn8n integration.",
            "",
            `Event: ${delivery.eventType}`,
            "",
            JSON.stringify(delivery.payload || {}, null, 2).slice(0, 20_000),
          ].join("\n"),
          labels: ["mecordxn8n"],
        }),
      },
      fetchImpl,
    );
    return {
      providerReference: result.html_url || String(result.number || ""),
    };
  }

  if (delivery.provider === "SLACK") {
    const result = await fetchImpl(delivery.config.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `Mecordxn8n · ${eventTitle(delivery.eventType)}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Mecordxn8n* · ${eventTitle(delivery.eventType)}\nEvent: ${delivery.eventType}`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Delivery ID: ${delivery.id}`,
              },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!result.ok) {
      throw deliveryError(
        `HTTP_${result.status}`,
        `Slack returned HTTP ${result.status}`,
      );
    }
    return { providerReference: "slack-webhook" };
  }

  if (delivery.provider === "WEBHOOK") {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac(
      "sha256",
      delivery.config.signingSecret,
    )
      .update(`${timestamp}.${serialized}`)
      .digest("hex");
    await safeWebhookPost({
      url: delivery.config.url,
      body: serialized,
      lookup,
      headers: {
        "X-Mecord-Event-Id": delivery.id,
        "X-Mecord-Event-Type": delivery.eventType,
        "X-Mecord-Timestamp": timestamp,
        "X-Mecord-Signature": `sha256=${signature}`,
      },
    });
    return { providerReference: delivery.id };
  }

  throw deliveryError(
    "PROVIDER_NOT_OUTBOUND",
    "this integration provider does not support outbound delivery",
  );
}
