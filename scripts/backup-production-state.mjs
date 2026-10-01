import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const appUrl = String(process.env.DATABASE_URL || "").trim();
const n8nUrl = String(process.env.N8N_DATABASE_URL || "").trim();
const key = String(process.env.BACKUP_ENCRYPTION_KEY || "").trim();

if (!appUrl) throw new Error("DATABASE_URL is required");
if (!n8nUrl) throw new Error("N8N_DATABASE_URL is required");
if (key.length < 32) {
  throw new Error("BACKUP_ENCRYPTION_KEY must be at least 32 characters");
}

const outputDir = path.resolve(process.argv[2] || "artifacts/production-backup");
fs.mkdirSync(outputDir, { recursive: true });

async function runBackup(name, databaseUrl) {
  const output = path.join(outputDir, name + ".backup.enc");
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/backup-database.mjs", output],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          BACKUP_DATABASE_URL: databaseUrl,
          BACKUP_ENCRYPTION_KEY: key,
        },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(name + " backup failed with exit " + code));
    });
  });
  return {
    backup: path.basename(output),
    manifest: path.basename(output) + ".json",
  };
}

const app = await runBackup("mecordxn8n", appUrl);
const n8n = await runBackup("n8n", n8nUrl);

await new Promise((resolve, reject) => {
  const child = spawn(
    process.execPath,
    [
      "scripts/backup-evidence.mjs",
      process.env.EVIDENCE_STORE_DIR || "/evidence",
      path.join(outputDir, "evidence"),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BACKUP_ENCRYPTION_KEY: key,
      },
    },
  );
  child.on("error", reject);
  child.on("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error("evidence backup failed with exit " + code)),
  );
});

const evidenceManifest = JSON.parse(
  fs.readFileSync(path.join(outputDir, "evidence", "manifest.json"), "utf8"),
);

const manifest = {
  kind: "PRODUCTION_STATE",
  encrypted: true,
  applicationDatabase: app,
  n8nDatabase: n8n,
  evidence: {
    manifest: "evidence/manifest.json",
    artifactCount: evidenceManifest.artifactCount,
    encrypted: true,
  },
  createdAt: new Date().toISOString(),
};

fs.writeFileSync(
  path.join(outputDir, "production-state.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(manifest));
