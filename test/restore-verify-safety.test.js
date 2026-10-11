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
