import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { pool } from "./repository.js";

const SHA256_RE = /^[a-f0-9]{64}$/i;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;

function storeRoot(env = process.env) {
  return path.resolve(String(env.EVIDENCE_STORE_DIR || "/evidence"));
}

function evidencePath(root, sha256) {
  return path.join(root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
}

export async function storeWorkerEvidence({
  jobId,
  workerId,
  expectedSha256,
  bytes,
  contentType = "application/octet-stream",
  env = process.env,
}) {
  if (!Buffer.isBuffer(bytes)) {
    const error = new Error("evidence bytes must be a Buffer");
    error.statusCode = 400;
    error.code = "EVIDENCE_BODY_INVALID";
    throw error;
  }
  if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES) {
    const error = new Error("evidence artifact size is outside allowed bounds");
    error.statusCode = 413;
    error.code = "EVIDENCE_SIZE_INVALID";
    throw error;
  }
  const normalizedExpected = String(expectedSha256 || "").trim().toLowerCase();
  if (!SHA256_RE.test(normalizedExpected)) {
    const error = new Error("x-evidence-sha256 is required");
    error.statusCode = 400;
    error.code = "EVIDENCE_SHA256_REQUIRED";
    throw error;
  }

  const lease = await pool.query(
    `SELECT id, target_id
       FROM jobs
      WHERE id = $1
        AND state = 'RUNNING'
        AND lease_owner = $2
        AND lease_expires_at > now()`,
    [jobId, workerId],
  );
  if (lease.rowCount === 0) {
    const error = new Error("active worker lease required for evidence upload");
    error.statusCode = 409;
    error.code = "EVIDENCE_LEASE_REQUIRED";
    throw error;
  }

  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== normalizedExpected) {
    const error = new Error("evidence checksum mismatch");
    error.statusCode = 409;
    error.code = "EVIDENCE_CHECKSUM_MISMATCH";
    throw error;
  }

  const root = storeRoot(env);
  const destination = evidencePath(root, actualSha256);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });

  let created = false;
  try {
    const handle = await fs.open(destination, "wx", 0o400);
    try {
      await handle.writeFile(bytes);
      created = true;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await fs.readFile(destination);
    const existingSha = createHash("sha256").update(existing).digest("hex");
    if (existingSha !== actualSha256 || existing.length !== bytes.length) {
      const integrity = new Error("content-addressed evidence collision");
      integrity.statusCode = 500;
      integrity.code = "EVIDENCE_STORE_INTEGRITY";
      throw integrity;
    }
  }

  return {
    kind: String(contentType || "application/octet-stream").slice(0, 120),
    path: `evidence://sha256/${actualSha256}`,
    sha256: actualSha256,
    byteLength: bytes.length,
    targetId: lease.rows[0].target_id,
    immutable: true,
    deduplicated: !created,
  };
}

export async function verifyEvidenceReference(reference, env = process.env) {
  const match = String(reference || "").match(/^evidence:\/\/sha256\/([a-f0-9]{64})$/i);
  if (!match) return { valid: false, reason: "REFERENCE_INVALID" };
  const sha256 = match[1].toLowerCase();
  const file = evidencePath(storeRoot(env), sha256);
  try {
    const bytes = await fs.readFile(file);
    const actual = createHash("sha256").update(bytes).digest("hex");
    return {
      valid: actual === sha256,
      sha256,
      byteLength: bytes.length,
    };
  } catch {
    return { valid: false, sha256, reason: "NOT_FOUND" };
  }
}

export { MAX_EVIDENCE_BYTES };
