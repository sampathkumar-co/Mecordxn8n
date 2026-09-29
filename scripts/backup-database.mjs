import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const output = process.argv[2] || path.resolve("artifacts", "database.backup");
fs.mkdirSync(path.dirname(output), { recursive: true });

await new Promise((resolve, reject) => {
  const child = spawn("pg_dump", [
    databaseUrl,
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--file",
    output,
  ], { stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error("pg_dump failed with exit " + code)),
  );
});

const bytes = fs.readFileSync(output);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const manifest = {
  kind: "DATABASE",
  file: path.basename(output),
  byteLength: bytes.length,
  sha256,
  createdAt: new Date().toISOString(),
};
fs.writeFileSync(output + ".json", JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));
