import { resolvePublicAddress } from "../workers/public-http.js";

export const INTEGRATION_PROVIDERS = Object.freeze([
  "GITHUB",
  "SLACK",
  "STRIPE",
  "WEBHOOK",
]);

export const INTEGRATION_EVENTS = Object.freeze([
  "finding.verified",
  "approval.pending",
  "regression.opened",
  "remediation.succeeded",
  "revenue.received",
  "service.renewal_due",
  "system.test",
]);

function invalid(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = "INVALID_INTEGRATION_CONFIG";
  throw error;
}

function requiredString(value, name, max = 2000) {
  const text = String(value || "").trim();
  if (!text || text.length > max) invalid(`${name} is invalid`);
  return text;
}

export async function validateIntegrationConfig(
  provider,
  input,
  { lookup } = {},
) {
  if (!INTEGRATION_PROVIDERS.includes(provider)) invalid("provider is invalid");
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    invalid("config must be an object");
  }

  if (provider === "GITHUB") {
    const token = requiredString(input.token, "token", 1000);
    const owner = requiredString(input.owner, "owner", 100);
    const repo = requiredString(input.repo, "repo", 100);
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
      invalid("GitHub owner/repo is invalid");
    }
    return { token, owner, repo };
  }

  if (provider === "SLACK") {
    const webhookUrl = requiredString(input.webhookUrl, "webhookUrl", 2000);
    let url;
    try {
      url = new URL(webhookUrl);
    } catch {
      invalid("Slack webhook URL is invalid");
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "hooks.slack.com" ||
      !url.pathname.startsWith("/services/")
    ) {
      invalid("Slack webhook URL must use hooks.slack.com/services");
    }
    return { webhookUrl: url.toString() };
  }

  if (provider === "STRIPE") {
    const webhookSecret = requiredString(
      input.webhookSecret,
      "webhookSecret",
      1000,
    );
    return { webhookSecret };
  }

  const webhookUrl = requiredString(input.url, "url", 2000);
  const signingSecret = requiredString(
    input.signingSecret,
    "signingSecret",
    1000,
  );
  if (signingSecret.length < 24) invalid("signingSecret is too short");
  let url;
  try {
    url = new URL(webhookUrl);
  } catch {
    invalid("webhook URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    invalid("generic webhooks require credential-free HTTPS URLs");
  }
  await resolvePublicAddress(url.hostname, lookup);
  return { url: url.toString(), signingSecret };
}

export function validateSubscribedEvents(events) {
  if (!Array.isArray(events)) invalid("subscribedEvents must be an array");
  const unique = [...new Set(events.map((item) => String(item)))];
  if (unique.some((item) => !INTEGRATION_EVENTS.includes(item))) {
    invalid("subscribedEvents contains an unsupported event");
  }
  return unique;
}

export function publicIntegrationConfig(provider, config) {
  if (provider === "GITHUB") {
    return { owner: config.owner, repo: config.repo, tokenConfigured: true };
  }
  if (provider === "SLACK") return { webhookConfigured: true };
  if (provider === "STRIPE") return { webhookSecretConfigured: true };
  if (provider === "WEBHOOK") {
    const url = new URL(config.url);
    return {
      endpoint: `${url.protocol}//${url.host}${url.pathname}`,
      signingSecretConfigured: true,
    };
  }
  return {};
}
