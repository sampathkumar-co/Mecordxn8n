import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve("web/console");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && full.endsWith(".js") ? [full] : [];
  });
}

const files = walk(root).sort();
const failures = [];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failures.push({
      file: path.relative(process.cwd(), file),
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
}

if (failures.length) {
  console.error(JSON.stringify({ status: "FAILED", failures }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  status: "PASSED",
  consoleModulesChecked: files.length,
}));
