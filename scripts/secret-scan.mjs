import fs from "node:fs";
import path from "node:path";

const root = ".";
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "artifacts",
  "playwright-report",
  "test-results",
  ".cache",
]);
const ignoredFiles = new Set(["package-lock.json"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const patterns = [
  { name: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { name: "github-fine-grained-token", regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "stripe-secret", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
];

function walk(dir) {
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.isDirectory() && ignoredDirectories.has(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...walk(full));
    } else if (item.isFile()) {
      entries.push(full);
    }
  }
  return entries;
}

function isProbablyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

const hits = [];
let filesScanned = 0;
let filesSkipped = 0;

for (const file of walk(root)) {
  if (ignoredFiles.has(path.basename(file))) {
    filesSkipped += 1;
    continue;
  }

  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) {
    filesSkipped += 1;
    continue;
  }

  const buffer = fs.readFileSync(file);
  if (isProbablyBinary(buffer)) {
    filesSkipped += 1;
    continue;
  }

  const text = buffer.toString("utf8");
  filesScanned += 1;
  for (const pattern of patterns) {
    if (pattern.regex.test(text)) {
      hits.push({ file: path.relative(root, file), pattern: pattern.name });
    }
  }
}

if (hits.length) {
  console.error(JSON.stringify({
    secretScan: "FAILED",
    filesScanned,
    filesSkipped,
    hits,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  secretScan: "PASSED",
  filesScanned,
  filesSkipped,
}));
