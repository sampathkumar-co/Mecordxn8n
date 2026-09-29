import { spawn } from "node:child_process";
import fs from "node:fs";
import pg from "pg";

const { Pool } = pg;
const backup = process.argv[2];
const verifyUrl = process.env.RESTORE_DATABASE_URL;

if (!backup || !fs.existsSync(backup)) {
  throw new Error("backup file path is required");
}
if (!verifyUrl) throw new Error("RESTORE_DATABASE_URL is required");

await new Promise((resolve, reject) => {
  const child = spawn("pg_restore", [
    "--clean",
    "--if-exists",
    "--no-owner",
    "--no-acl",
    "--dbname",
    verifyUrl,
    backup,
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
    requiredTables: required.length,
    verifiedAt: new Date().toISOString(),
  }));
} finally {
  await pool.end();
}
