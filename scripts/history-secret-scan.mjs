import { spawn } from "node:child_process";
import readline from "node:readline";

const patterns = [
  { name: "private-key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "github-token", regex: /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/ },
  { name: "github-fine-grained-token", regex: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: "stripe-secret", regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "npm-token", regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "google-api-key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

const child = spawn(
  "git",
  ["log", "--all", "-p", "--no-ext-diff", "--no-textconv", "--format=commit:%H", "--", "."],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let commit = null;
let lineCount = 0;
const hits = [];
const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

const rl = readline.createInterface({
  input: child.stdout,
  crlfDelay: Infinity,
});
for await (const line of rl) {
  lineCount += 1;
  if (line.startsWith("commit:")) {
    commit = line.slice("commit:".length).trim();
    continue;
  }
  if (!(line.startsWith("+") || line.startsWith("-"))) continue;
  if (line.startsWith("+++") || line.startsWith("---")) continue;

  for (const pattern of patterns) {
    if (pattern.regex.test(line)) {
      hits.push({
        commit,
        pattern: pattern.name,
        sample: "[redacted]",
      });
      if (hits.length >= 100) {
        child.kill("SIGTERM");
        break;
      }
    }
  }
  if (hits.length >= 100) break;
}

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
if (exitCode !== 0 && hits.length === 0) {
  throw new Error("git history scan failed: " + stderr.join("").slice(0, 1000));
}

if (hits.length) {
  console.error(JSON.stringify({
    secretHistoryScan: "FAILED",
    lineCount,
    hits,
  }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({
  secretHistoryScan: "PASSED",
  lineCount,
}));
