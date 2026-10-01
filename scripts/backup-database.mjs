import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const databaseUrl = process.env.BACKUP_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("BACKUP_DATABASE_URL or DATABASE_URL is required");

const output = process.argv[2] || path.resolve("artifacts", "database.backup");
const encryptionSecret = String(process.env.BACKUP_ENCRYPTION_KEY || "").trim();
fs.mkdirSync(path.dirname(output), { recursive: true });

const plainOutput = encryptionSecret ? output + ".plain.tmp" : output;

await new Promise((resolve, reject) => {
  const child = spawn("pg_dump", [
    databaseUrl,
    "--format=custom",
    "--no-owner",
    "--no-acl",
    "--file",
    plainOutput,
  ], { stdio: "inherit" });
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0 ? resolve() : reject(new Error("pg_dump failed with exit " + code)),
  );
});

let encryption = null;
if (encryptionSecret) {
  if (encryptionSecret.length < 32) {
    await fsp.rm(plainOutput, { force: true });
    throw new Error("BACKUP_ENCRYPTION_KEY must be at least 32 characters");
  }
  const key = createHash("sha256").update(encryptionSecret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  try {
    await pipeline(
      fs.createReadStream(plainOutput),
      cipher,
      fs.createWriteStream(output, { mode: 0o600 }),
    );
    encryption = {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  } finally {
    await fsp.rm(plainOutput, { force: true });
  }
}

const bytes = await fsp.readFile(output);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const manifest = {
  kind: "DATABASE",
  file: path.basename(output),
  byteLength: bytes.length,
  sha256,
  encryption,
  createdAt: new Date().toISOString(),
};
await fsp.writeFile(
  output + ".json",
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(manifest));
