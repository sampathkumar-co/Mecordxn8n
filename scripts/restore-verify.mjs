import {
  createDecipheriv,
  createHash,
} from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";

const { Pool } = pg;
const backup = process.argv[2];
const verifyUrl = process.env.RESTORE_DATABASE_URL;

if (!backup || !fs.existsSync(backup)) {
  throw new Error("backup file path is required");
}
if (!verifyUrl) throw new Error("RESTORE_DATABASE_URL is required");

const manifestPath = backup + ".json";
if (!fs.existsSync(manifestPath)) {
  throw new Error("backup checksum manifest is required");
}
const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
const backupBytes = await fsp.readFile(backup);
const actualSha = createHash("sha256").update(backupBytes).digest("hex");
if (actualSha !== manifest.sha256 || backupBytes.length !== manifest.byteLength) {
  throw new Error("backup checksum or byte length does not match manifest");
}

let restoreInput = backup;
let decryptedTemp = null;
if (manifest.encryption) {
  const secret = String(process.env.BACKUP_ENCRYPTION_KEY || "").trim();
  if (secret.length < 32) {
    throw new Error("BACKUP_ENCRYPTION_KEY is required for encrypted restore");
  }
  if (manifest.encryption.algorithm !== "aes-256-gcm") {
    throw new Error("unsupported backup encryption algorithm");
  }
  const key = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(manifest.encryption.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(manifest.encryption.tag, "base64"));
  decryptedTemp = path.resolve(
    path.dirname(backup),
    "." + path.basename(backup) + ".restore.tmp",
  );
  await pipeline(
    fs.createReadStream(backup),
    decipher,
    fs.createWriteStream(decryptedTemp, { mode: 0o600 }),
  );
  restoreInput = decryptedTemp;
}

try {
  await new Promise((resolve, reject) => {
    const child = spawn("pg_restore", [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-acl",
      "--dbname",
      verifyUrl,
      restoreInput,
    ], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("pg_restore failed with exit " + code)),
    );
  });

  const pool = new Pool({ connectionString: verifyUrl });
  try {
    const required = [
      "targets",
      "findings",
      "approval_requests",
      "commercial_opportunities",
      "workspaces",
      "platform_users",
      "integration_connections",
      "integration_outbox",
    ];
    const result = await pool.query(
      `SELECT tablename
         FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename = ANY($1::text[])`,
      [required],
    );
    const found = new Set(result.rows.map((row) => row.tablename));
    const missing = required.filter((name) => !found.has(name));
    if (missing.length) {
      throw new Error("restore verification missing tables: " + missing.join(", "));
    }
    console.log(JSON.stringify({
      restoreVerified: true,
      encrypted: Boolean(manifest.encryption),
      checksumVerified: true,
      requiredTables: required.length,
      verifiedAt: new Date().toISOString(),
    }));
  } finally {
    await pool.end();
  }
} finally {
  if (decryptedTemp) await fsp.rm(decryptedTemp, { force: true });
}
