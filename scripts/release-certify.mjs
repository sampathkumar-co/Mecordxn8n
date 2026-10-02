import fs from "node:fs";

const requiredFiles = [
  "db/migrations/009_release_integrations.sql",
  "db/migrations/010_milestone_h_launch.sql",
  "db/migrations/011_post_h_hardening.sql",
  "db/migrations/012_production_hardening_ii.sql",
  "db/migrations/013_privileged_mfa.sql",
  "db/migrations/014_account_recovery.sql",
  "src/evidence-store.js",
  "src/platform/mfa.js",
  "src/platform/mfa-policy.js",
  "src/platform/auth-mail.js",
  "src/platform/dependencies.js",
  "src/platform/routes.js",
  "src/integrations/routes.js",
  "src/integrations/repository.js",
  "src/integrations/delivery.js",
  "src/workers/integration-worker.js",
  "src/workers/integration-service.js",
  "web/console/index.html",
  "web/console/app.js",
  "web/console/core/api.js",
  "web/console/core/router.js",
  "web/console/core/permissions.js",
  "web/console/components/actions.js",
  "web/console/components/command-palette.js",
  "web/console/views/home.js",
  "web/console/views/targets.js",
  "web/console/views/findings.js",
  "web/console/views/approvals.js",
  "web/console/views/repairs.js",
  "web/console/views/runs.js",
  "web/console/views/revenue.js",
  "web/console/views/integrations.js",
  "web/console/views/workspace.js",
  "web/console/styles/tokens.css",
  "web/console/styles/layout.css",
  "web/console/styles/components.css",
  "web/console/styles/views.css",
  "scripts/backup-database.mjs",
  "scripts/backup-production-state.mjs",
  "scripts/backup-evidence.mjs",
  "scripts/verify-evidence-backup.mjs",
  "scripts/restore-verify.mjs",
  "scripts/history-secret-scan.mjs",
  "SECURITY.md",
  ".github/CODEOWNERS",
  ".github/dependabot.yml",
  ".github/workflows/codeql.yml",
  ".github/workflows/security.yml",
  ".github/workflows/release.yml",
  ".github/workflows/deploy-production.yml",
  "scripts/deploy-production-remote.sh",
  "scripts/render-host-caddy.mjs",
  "test/host-caddy.test.js",
  "docs/PRODUCTION_DEPLOYMENT.md",
  "n8n/workflows/integration-delivery-dispatch.json",
  "n8n/workflows/onboarding-finalization.json",
  "src/milestone-h/routes.js",
  "src/milestone-h/repository.js",
  "src/milestone-h/billing.js",
  "src/milestone-h/domain.js",
  "docker-compose.production.yml",
  "docker-compose.external.yml",
  "deploy/Caddyfile",
  "scripts/production-preflight.mjs",
  "scripts/production-smoke.mjs",
  "docs/UI_UX_V2_PLAN.md",
];

const missingFiles = requiredFiles.filter((file) => !fs.existsSync(file));
const workflows = fs
  .readdirSync("n8n/workflows")
  .filter((name) => name.endsWith(".json"));
const activeWorkflows = [];
for (const name of workflows) {
  const parsed = JSON.parse(fs.readFileSync("n8n/workflows/" + name, "utf8"));
  if (parsed.active === true) activeWorkflows.push(name);
}

const migrationFiles = fs
  .readdirSync("db/migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();
const expectedPrefix = migrationFiles.map((name) => name.slice(0, 3));
const sequenceValid = expectedPrefix.every(
  (value, index) => Number(value) === index + 1,
);

const externalComposeText = fs.readFileSync(
  "docker-compose.external.yml",
  "utf8",
);
const composeText = [
  fs.readFileSync("docker-compose.yml", "utf8"),
  fs.readFileSync("docker-compose.production.yml", "utf8"),
  externalComposeText,
].join("\n");
const mutableImageTags = [
  ...composeText.matchAll(
    /^\s*image:\s*([^\s#]+:(?:latest|edge|nightly))\s*(?:#.*)?$/gim,
  ),
].map((match) => match[1]);

function hasNonRootUser(file) {
  const text = fs.readFileSync(file, "utf8");
  return /^\s*USER\s+(?!root\b)\S+/im.test(text);
}

const caddyfile = fs.readFileSync("deploy/Caddyfile", "utf8");

function consoleSources(dir = "web/console") {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = dir + "/" + entry.name;
    if (entry.isDirectory()) return consoleSources(full);
    if (
      entry.isFile() &&
      (entry.name.endsWith(".html") || entry.name.endsWith(".js"))
    ) {
      return [full];
    }
    return [];
  });
}

const uiSources = consoleSources();
const consoleHasInlineStyles = uiSources.some((file) =>
  fs.readFileSync(file, "utf8").includes('style="'),
);
const consoleIndex = fs.readFileSync("web/console/index.html", "utf8");

const checks = {
  requiredFiles: missingFiles.length === 0,
  inactiveN8nImports: activeWorkflows.length === 0,
  migrationSequence: sequenceValid,
  immutableRuntimeTags: mutableImageTags.length === 0,
  controlImageNonRoot: hasNonRootUser("Dockerfile"),
  browserImageNonRoot: hasNonRootUser("Dockerfile.browser"),
  ingressContentSecurityPolicy: /Content-Security-Policy/i.test(caddyfile),
  controlCenterV2Only: !fs.existsSync("web/console/styles.css"),
  controlCenterCspCompatible:
    !consoleHasInlineStyles &&
    !/<form[^>]+method=["']dialog["']/i.test(consoleIndex),
  controlCenterDeepLinks:
    /History API deep links/i.test(fs.readFileSync("docs/UI_UX_V2_PLAN.md", "utf8")) ||
    /History API routing/i.test(fs.readFileSync("docs/UI_UX_V2_PLAN.md", "utf8")),
  packageLockVersionMatches:
    JSON.parse(fs.readFileSync("package-lock.json", "utf8")).version ===
    JSON.parse(fs.readFileSync("package.json", "utf8")).version,
  productionImagePinning:
    composeText.includes("NODE_BASE_IMAGE") &&
    composeText.includes("PLAYWRIGHT_BASE_IMAGE") &&
    composeText.includes("POSTGRES_IMAGE") &&
    composeText.includes("N8N_IMAGE") &&
    fs.readFileSync("docker-compose.production.yml", "utf8").includes("CADDY_IMAGE"),
  productionTrustZones:
    composeText.includes("n8n-postgres:") &&
    composeText.includes("evidence_store:/evidence") &&
    !composeText.includes("browser_artifacts:/artifacts") &&
    !composeText.includes("verification_artifacts:/artifacts"),
  productionScopedWorkers:
    composeText.includes("WORKER_TOKEN_BROWSER_QA") &&
    composeText.includes("WORKER_TOKEN_REMEDIATION") &&
    composeText.includes("WORKER_TOKEN_INTEGRATION"),
  mecordServiceAuthentication:
    composeText.includes("MECORD_OAUTH_CLIENT_ID") &&
    composeText.includes("MECORD_OAUTH_CLIENT_SECRET") &&
    fs.readFileSync("src/mcp/mecord-client.js", "utf8")
      .includes("client_credentials") &&
    fs.readFileSync("scripts/production-preflight.mjs", "utf8")
      .includes("MECORD_OAUTH_CLIENT_SECRET"),
  immutableEvidenceReferences:
    fs.readFileSync("src/milestone-a/repository.js", "utf8")
      .includes("evidence://sha256/"),
  verifiedEmailAndMfa:
    fs.readFileSync("src/platform/mfa-policy.js", "utf8")
      .includes("MFA_STEP_UP_REQUIRED") &&
    fs.readFileSync("src/platform/mfa-policy.js", "utf8")
      .includes("EMAIL_VERIFICATION_REQUIRED"),
  externalIngressIsolation:
    composeText.includes("CONTROL_API_HOST_PORT") &&
    composeText.includes("N8N_HOST_PORT") &&
    fs.readFileSync("docker-compose.production.yml", "utf8")
      .includes("standalone-ingress") &&
    externalComposeText.includes("EXTERNAL_INGRESS_NETWORK") &&
    externalComposeText.includes("mecordxn8n-control-api") &&
    fs.readFileSync("scripts/render-host-caddy.mjs", "utf8")
      .includes("EXTERNAL_INGRESS_UPSTREAM") &&
    fs.readFileSync("scripts/render-host-caddy.mjs", "utf8")
      .includes("reverse_proxy ${upstream}"),
  productionDeploymentGate: (() => {
    const workflow = fs.readFileSync(
      ".github/workflows/deploy-production.yml",
      "utf8",
    );
    const remote = fs.readFileSync(
      "scripts/deploy-production-remote.sh",
      "utf8",
    );
    return (
      workflow.includes("workflow_dispatch:") &&
      workflow.includes("github.ref == 'refs/heads/main'") &&
      workflow.includes("environment: production") &&
      workflow.includes("StrictHostKeyChecking=yes") &&
      workflow.includes('PRODUCTION_SMOKE_STRICT: "true"') &&
      workflow.includes("DEPLOY_KNOWN_HOSTS") &&
      workflow.includes("DEPLOY_INGRESS_MODE") &&
      workflow.includes("CONTROL_API_HOST_PORT") &&
      workflow.includes("parseEnv") &&
      workflow.includes("render-host-caddy.mjs") &&
      remote.includes("sha256sum") &&
      remote.includes("--env-file .env") &&
      remote.includes("standalone-ingress") &&
      remote.includes("docker-compose.external.yml") &&
      remote.includes("external_ingress_network") &&
      remote.includes("127.0.0.1:") &&
      remote.includes("production-preflight.mjs") &&
      remote.includes("docker compose") &&
      remote.includes("config --images") &&
      remote.includes("docker image inspect") &&
      remote.includes("/run/mecordxn8n-production.env") &&
      remote.includes("--env-file=/run/mecordxn8n-production.env") &&
      remote.includes("healthz")
    );
  })(),
  productionVersion: JSON.parse(fs.readFileSync("package.json", "utf8")).version,
};

const failedChecks = Object.entries(checks)
  .filter(([name, value]) => name !== "productionVersion" && value !== true)
  .map(([name]) => name);

if (
  missingFiles.length ||
  activeWorkflows.length ||
  !sequenceValid ||
  mutableImageTags.length ||
  failedChecks.length
) {
  console.error(JSON.stringify({
    status: "FAILED",
    checks,
    failedChecks,
    missingFiles,
    activeWorkflows,
    mutableImageTags,
  }, null, 2));
  process.exit(1);
}

fs.mkdirSync("artifacts", { recursive: true });
const manifest = {
  status: "PASSED",
  version: checks.productionVersion,
  gitSha: process.env.GITHUB_SHA || process.env.GIT_SHA || "local",
  checks,
  certifiedAt: new Date().toISOString(),
};
fs.writeFileSync(
  "artifacts/release-certification.json",
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(JSON.stringify(manifest));
