import fs from "node:fs";

const requiredFiles = [
  "db/migrations/009_release_integrations.sql",
  "src/platform/routes.js",
  "src/integrations/routes.js",
  "src/integrations/repository.js",
  "src/integrations/delivery.js",
  "src/workers/integration-dispatcher-service.js",
  "web/console/index.html",
  "web/console/app.js",
  "scripts/backup-database.mjs",
  "scripts/restore-verify.mjs",
  ".github/workflows/security.yml",
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

const checks = {
  requiredFiles: missingFiles.length === 0,
  inactiveN8nImports: activeWorkflows.length === 0,
  migrationSequence: sequenceValid,
  productionVersion: JSON.parse(fs.readFileSync("package.json", "utf8")).version,
};

if (missingFiles.length || activeWorkflows.length || !sequenceValid) {
  console.error(JSON.stringify({
    status: "FAILED",
    checks,
    missingFiles,
    activeWorkflows,
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
