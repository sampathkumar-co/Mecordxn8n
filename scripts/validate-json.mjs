import fs from "node:fs/promises";

const paths = [
  "package.json",
  "n8n/workflows/job-intake.json",
  "n8n/workflows/public-http-dispatch.json",
  "n8n/workflows/browser-qa-dispatch.json",
  "n8n/workflows/site-discovery-dispatch.json",
  "n8n/workflows/journey-qa-dispatch.json",
  "n8n/workflows/finding-verification-dispatch.json",
  "n8n/workflows/remediation-dispatch.json",
  "n8n/workflows/production-maintenance.json",
  "n8n/workflows/commercial-maintenance.json",
  "n8n/workflows/integration-delivery-dispatch.json",
  "n8n/workflows/onboarding-finalization.json",
];

for (const path of paths) {
  const text = await fs.readFile(new URL(`../${path}`, import.meta.url), "utf8");
  JSON.parse(text);
  console.log(`valid JSON: ${path}`);
}
