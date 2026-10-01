const required = [
  "NODE_BASE_IMAGE",
  "PLAYWRIGHT_BASE_IMAGE",
  "POSTGRES_IMAGE",
  "N8N_IMAGE",
  "CADDY_IMAGE",
  "DATABASE_URL",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "N8N_POSTGRES_DB",
  "N8N_POSTGRES_USER",
  "N8N_POSTGRES_PASSWORD",
  "N8N_DATABASE_URL",
  "ORCHESTRATOR_TOKEN",
  "WORKER_TOKEN_HTTP_OBSERVER",
  "WORKER_TOKEN_BROWSER_QA",
  "WORKER_TOKEN_SITE_DISCOVERY",
  "WORKER_TOKEN_JOURNEY_QA",
  "WORKER_TOKEN_FINDING_VERIFICATION",
  "WORKER_TOKEN_REMEDIATION",
  "WORKER_TOKEN_INTEGRATION",
  "WORKER_TRIGGER_TOKEN",
  "N8N_ENCRYPTION_KEY",
  "BACKUP_ENCRYPTION_KEY",
  "PLATFORM_MASTER_KEY",
  "PLATFORM_AUTH_KEY",
  "AUTH_MAIL_WEBHOOK_SECRET",
  "MECORD_MCP_TOKEN",
  "BOOTSTRAP_TOKEN",
  "APP_DOMAIN",
  "ACME_EMAIL",
  "PUBLIC_APP_URL",
  "AUTH_MAIL_WEBHOOK_URL",
  "AUTH_MAIL_WEBHOOK_SECRET",
  "MECORD_MCP_URL",
  "MECORD_MCP_TOKEN",
  "MECORD_HEALTH_URL",
  "N8N_HEALTH_URL",
];

const errors = [];
const values = {};
const DIGEST_IMAGE_RE = /^[^\s]+@sha256:[a-f0-9]{64}$/i;
for (const name of required) {
  const value = String(process.env[name] || "").trim();
  values[name] = value;
  if (!value) errors.push(name + " is required");
  if (/replace-with|changeme|example-secret|password123/i.test(value)) {
    errors.push(name + " still contains a placeholder");
  }
}

for (const name of [
  "NODE_BASE_IMAGE",
  "PLAYWRIGHT_BASE_IMAGE",
  "POSTGRES_IMAGE",
  "N8N_IMAGE",
  "CADDY_IMAGE",
]) {
  if (values[name] && !DIGEST_IMAGE_RE.test(values[name])) {
    errors.push(name + " must be pinned to an @sha256:<64-hex> digest");
  }
}

for (const name of [
  "POSTGRES_PASSWORD",
  "N8N_POSTGRES_PASSWORD",
  "ORCHESTRATOR_TOKEN",
  "WORKER_TOKEN_HTTP_OBSERVER",
  "WORKER_TOKEN_BROWSER_QA",
  "WORKER_TOKEN_SITE_DISCOVERY",
  "WORKER_TOKEN_JOURNEY_QA",
  "WORKER_TOKEN_FINDING_VERIFICATION",
  "WORKER_TOKEN_REMEDIATION",
  "WORKER_TOKEN_INTEGRATION",
  "WORKER_TRIGGER_TOKEN",
  "N8N_ENCRYPTION_KEY",
  "BACKUP_ENCRYPTION_KEY",
  "PLATFORM_MASTER_KEY",
  "PLATFORM_AUTH_KEY",
  "BOOTSTRAP_TOKEN",
]) {
  if (values[name] && values[name].length < 32) {
    errors.push(name + " must be at least 32 characters");
  }
}

const workerTokenNames = [
  "WORKER_TOKEN_HTTP_OBSERVER",
  "WORKER_TOKEN_BROWSER_QA",
  "WORKER_TOKEN_SITE_DISCOVERY",
  "WORKER_TOKEN_JOURNEY_QA",
  "WORKER_TOKEN_FINDING_VERIFICATION",
  "WORKER_TOKEN_REMEDIATION",
  "WORKER_TOKEN_INTEGRATION",
];
const workerTokens = workerTokenNames.map((name) => values[name]).filter(Boolean);
if (new Set(workerTokens).size !== workerTokens.length) {
  errors.push("every worker token must be unique");
}
if (
  values.POSTGRES_PASSWORD &&
  values.N8N_POSTGRES_PASSWORD &&
  values.POSTGRES_PASSWORD === values.N8N_POSTGRES_PASSWORD
) {
  errors.push("n8n must not reuse the application PostgreSQL password");
}
if (
  values.POSTGRES_DB === values.N8N_POSTGRES_DB &&
  values.POSTGRES_USER === values.N8N_POSTGRES_USER
) {
  errors.push("n8n must use a separate PostgreSQL database/user");
}
const controlSecrets = [
  values.ORCHESTRATOR_TOKEN,
  values.WORKER_TRIGGER_TOKEN,
  ...workerTokens,
].filter(Boolean);
if (new Set(controlSecrets).size !== controlSecrets.length) {
  errors.push("orchestrator, trigger and worker credentials must all be distinct");
}

const integrationKeyVersion = Number(
  process.env.PLATFORM_MASTER_KEY_ACTIVE_VERSION || 1,
);
if (
  !Number.isInteger(integrationKeyVersion) ||
  integrationKeyVersion < 1 ||
  integrationKeyVersion > 9999
) {
  errors.push("PLATFORM_MASTER_KEY_ACTIVE_VERSION must be an integer from 1 to 9999");
} else if (integrationKeyVersion > 1) {
  const activeKey = String(
    process.env[`PLATFORM_MASTER_KEY_V${integrationKeyVersion}`] || "",
  ).trim();
  if (activeKey.length < 32) {
    errors.push(
      `PLATFORM_MASTER_KEY_V${integrationKeyVersion} must be configured and at least 32 characters`,
    );
  }
}

if (
  String(process.env.REQUIRE_PRIVILEGED_MFA || "").trim().toLowerCase() !==
  "true"
) {
  errors.push("REQUIRE_PRIVILEGED_MFA must be true in production");
}
if (
  String(process.env.REQUIRE_VERIFIED_EMAIL || "").trim().toLowerCase() !==
  "true"
) {
  errors.push("REQUIRE_VERIFIED_EMAIL must be true in production");
}

const mfaStepUpMinutes = Number(process.env.MFA_STEP_UP_MINUTES || 30);
if (
  !Number.isInteger(mfaStepUpMinutes) ||
  mfaStepUpMinutes < 1 ||
  mfaStepUpMinutes > 240
) {
  errors.push("MFA_STEP_UP_MINUTES must be an integer from 1 to 240");
}

if (
  String(process.env.DEPENDENCY_HEALTH_ENABLED || "").trim().toLowerCase() !==
  "true"
) {
  errors.push("DEPENDENCY_HEALTH_ENABLED must be true in production");
}

for (const name of ["MECORD_MCP_URL", "MECORD_HEALTH_URL"]) {
  if (values[name]) {
    let dependencyUrl;
    try { dependencyUrl = new URL(values[name]); } catch {}
    if (!dependencyUrl || dependencyUrl.protocol !== "https:") {
      errors.push(name + " must be an HTTPS URL");
    }
  }
}
if (values.N8N_HEALTH_URL) {
  let n8nHealth;
  try { n8nHealth = new URL(values.N8N_HEALTH_URL); } catch {}
  if (
    !n8nHealth ||
    !["http:", "https:"].includes(n8nHealth.protocol) ||
    !["n8n", "127.0.0.1", "localhost"].includes(n8nHealth.hostname)
  ) {
    errors.push("N8N_HEALTH_URL must point to the internal n8n service");
  }
}

if (values.AUTH_MAIL_WEBHOOK_URL) {
  let mailUrl;
  try { mailUrl = new URL(values.AUTH_MAIL_WEBHOOK_URL); } catch {}
  if (!mailUrl || mailUrl.protocol !== "https:") {
    errors.push("AUTH_MAIL_WEBHOOK_URL must be an HTTPS URL");
  }
}

if (values.PUBLIC_APP_URL) {
  let url;
  try { url = new URL(values.PUBLIC_APP_URL); } catch {}
  if (!url || url.protocol !== "https:") {
    errors.push("PUBLIC_APP_URL must be an HTTPS URL");
  } else if (url.hostname !== values.APP_DOMAIN) {
    errors.push("PUBLIC_APP_URL hostname must equal APP_DOMAIN");
  }
}

for (const name of ["APP_DOMAIN"]) {
  if (values[name] && !/^[a-z0-9.-]+$/i.test(values[name])) {
    errors.push(name + " must be a hostname");
  }
}

if (process.env.STRIPE_SECRET_KEY) {
  for (const name of [
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRICE_TEAM",
    "STRIPE_PRICE_BUSINESS",
  ]) {
    if (!String(process.env[name] || "").trim()) {
      errors.push(name + " is required when Stripe billing is enabled");
    }
  }
}

if (errors.length) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  appDomain: values.APP_DOMAIN,
  stripeBillingConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
}));
