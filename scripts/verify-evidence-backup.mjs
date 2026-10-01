import {
  createDecipheriv,
  createHash,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const backupDir = path.resolve(
  process.argv[2] || "artifacts/production-backup/evidence",
);
const secret = String(process.env.BACKUP_ENCRYPTION_KEY || "").trim();
if (secret.length < 32) {
  throw new Error("BACKUP_ENCRYPTION_KEY must be at least 32 characters");
}
const key = createHash("sha256").update(secret).digest();
const manifest = JSON.parse(
  await fs.readFile(path.join(backupDir, "manifest.json"), "utf8"),
);

if (manifest.kind !== "EVIDENCE_STORE_BACKUP" || manifest.encrypted !== true) {
  throw new Error("invalid evidence backup manifest");
}

for (const artifact of manifest.artifacts || []) {
  const encrypted = await fs.readFile(
    path.join(backupDir, artifact.encryptedFile),
  );
  const encryptedSha256 = createHash("sha256")
    .update(encrypted)
    .digest("hex");
  if (
    encryptedSha256 !== artifact.encryptedSha256 ||
    encrypted.length !== artifact.encryptedByteLength
  ) {
    throw new Error("encrypted evidence checksum mismatch: " + artifact.sha256);
  }

  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(artifact.encryption.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(artifact.encryption.tag, "base64"));
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const sha256 = createHash("sha256").update(plain).digest("hex");
  if (
    sha256 !== artifact.sha256 ||
    plain.length !== artifact.byteLength
  ) {
    throw new Error("decrypted evidence checksum mismatch: " + artifact.sha256);
  }
}

console.log(JSON.stringify({
  evidenceRestoreVerified: true,
  artifactCount: (manifest.artifacts || []).length,
  verifiedAt: new Date().toISOString(),
}));
