const required = [
  "DATABASE_URL",
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "ORCHESTRATOR_TOKEN",
  "WORKER_TOKEN",
  "WORKER_TRIGGER_TOKEN",
  "N8N_ENCRYPTION_KEY",
  "PLATFORM_MASTER_KEY",
  "BOOTSTRAP_TOKEN",
  "APP_DOMAIN",
  "N8N_DOMAIN",
  "ACME_EMAIL",
  "PUBLIC_APP_URL",
];

const errors = [];
const values = {};
for (const name of required) {
  const value = String(process.env[name] || "").trim();
  values[name] = value;
  if (!value) errors.push(name + " is required");
  if (/replace-with|changeme|example-secret|password123/i.test(value)) {
    errors.push(name + " still contains a placeholder");
  }
}

for (const name of [
  "POSTGRES_PASSWORD",
  "ORCHESTRATOR_TOKEN",
  "WORKER_TOKEN",
  "WORKER_TRIGGER_TOKEN",
  "N8N_ENCRYPTION_KEY",
  "PLATFORM_MASTER_KEY",
  "BOOTSTRAP_TOKEN",
]) {
  if (values[name] && values[name].length < 32) {
    errors.push(name + " must be at least 32 characters");
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

for (const name of ["APP_DOMAIN", "N8N_DOMAIN"]) {
  if (values[name] && !/^[a-z0-9.-]+$/i.test(values[name])) {
    errors.push(name + " must be a hostname");
  }
}
if (
  values.APP_DOMAIN &&
  values.N8N_DOMAIN &&
  values.APP_DOMAIN === values.N8N_DOMAIN
) {
  errors.push("APP_DOMAIN and N8N_DOMAIN must differ");
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
  n8nDomain: values.N8N_DOMAIN,
  stripeBillingConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
}));
