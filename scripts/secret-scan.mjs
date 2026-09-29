import fs from "node:fs";
import path from "node:path";

const roots = ["src", "scripts", "web", "n8n", "db", ".github", "deploy"];
const ignored = new Set(["package-lock.json"]);
const patterns = [
  { name: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "stripe-secret", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
];

function walk(dir) {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) entries.push(...walk(full));
    else entries.push(full);
  }
  return entries;
}

const hits = [];
for (const root of roots) {
  for (const file of walk(root)) {
    if (ignored.has(path.basename(file))) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of patterns) {
      if (pattern.regex.test(text)) hits.push({ file, pattern: pattern.name });
    }
  }
}
if (hits.length) {
  console.error(JSON.stringify({ secretScan: "FAILED", hits }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ secretScan: "PASSED", filesScanned: roots.length }));
