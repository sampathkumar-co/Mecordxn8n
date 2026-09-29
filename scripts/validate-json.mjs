import fs from "node:fs/promises";

const paths = [
  "package.json",
  "n8n/workflows/job-intake.json",
  "n8n/workflows/public-http-dispatch.json",
];

for (const path of paths) {
  const text = await fs.readFile(new URL(`../${path}`, import.meta.url), "utf8");
  JSON.parse(text);
  console.log(`valid JSON: ${path}`);
}
