import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function invokeRestore(extraEnv) {
  const folder = mkdtempSync(path.join(tmpdir(), "mecordxn8n-restore-guard-"));
  const backup = path.join(folder, "dummy.backup");
  writeFileSync(backup, "not a valid backup");
  try {
    const env = { ...process.env };
    for (const name of ["DATABASE_URL", "BACKUP_DATABASE_URL", "N8N_DATABASE_URL", "RESTORE_DATABASE_URL"]) {
      delete env[name];
    }
    Object.assign(env, extraEnv);
    return spawnSync(process.execPath, ["scripts/restore-verify.mjs", backup], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env, encoding: "utf8",
    });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

for (const source of ["DATABASE_URL", "BACKUP_DATABASE_URL", "N8N_DATABASE_URL"]) {
  test("verification restore refuses matching " + source + " even with URL aliases", () => {
    const out = invokeRestore({
      [source]: "postgres://original_user@127.0.0.1:5432/my_prod_db",
      RESTORE_DATABASE_URL: "postgresql://different_user@127.0.0.1/my_prod_db",
    });
    assert.equal(out.status, 1);
    assert.match(out.stderr, new RegExp("RESTORE_DATABASE_URL must not point at " + source));
    assert.doesNotMatch(out.stderr, /backup checksum manifest is required/);
  });
}

test("verification restore allows different database name to reach manifest validation", () => {
  const out = invokeRestore({
    DATABASE_URL: "postgres://user@127.0.0.1/my_prod_db",
    RESTORE_DATABASE_URL: "postgres://user@127.0.0.1/my_disposable_restore_db",
  });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /backup checksum manifest is required/);
  assert.doesNotMatch(out.stderr, /must not point at/);
});

test("verification restore refuses URL-encoded Unix socket identity", () => {
  const out = invokeRestore({
    DATABASE_URL: "postgresql://%2Fvar%2Flib%2Fpostgresql/app",
    RESTORE_DATABASE_URL: "postgresql:///app?host=%2Fvar%2Flib%2Fpostgresql",
  });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /must use a TCP PostgreSQL URL|ambiguous libpq forms are unsafe|must use a DNS\/IP TCP host/);
});

test("verification restore rejects libpq keyword-value source identities", () => {
  const out = invokeRestore({
    DATABASE_URL: "host=/var/lib/postgresql dbname=app",
    RESTORE_DATABASE_URL: "postgresql://127.0.0.1/restore_only",
  });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /ambiguous libpq forms are unsafe/);
});

test("verification restore rejects query-string host overrides", () => {
  const out = invokeRestore({
    DATABASE_URL: "postgresql://127.0.0.1/source",
    RESTORE_DATABASE_URL: "postgresql:///source?host=%2Fvar%2Flib%2Fpostgresql",
  });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /must use a TCP PostgreSQL URL/);
});

test("verification restore rejects the same database name across host aliases", () => {
  const out = invokeRestore({
    DATABASE_URL: "postgresql://db-main.internal/app",
    RESTORE_DATABASE_URL: "postgresql://db-alias.internal/app",
  });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /must not point at DATABASE_URL/);
});

test("verification restore still accepts a separate database with ordinary SSL options", () => {
  const out = invokeRestore({
    DATABASE_URL: "postgresql://db.internal/source?sslmode=require",
    RESTORE_DATABASE_URL: "postgresql://db.internal/restore_target?sslmode=require",
  });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /backup checksum manifest is required/);
});
