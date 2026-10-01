import {
  createCipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const sourceDir = path.resolve(
  process.env.EVIDENCE_STORE_DIR || process.argv[2] || "/evidence",
);
const outputDir = path.resolve(
  process.argv[3] || "artifacts/production-backup/evidence",
);
const secret = String(process.env.BACKUP_ENCRYPTION_KEY || "").trim();

if (secret.length < 32) {
  throw new Error("BACKUP_ENCRYPTION_KEY must be at least 32 characters");
}

const key = createHash("sha256").update(secret).digest();

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

const sourceFiles = await walk(sourceDir);
await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });

const artifacts = [];
for (const file of sourceFiles) {
  const bytes = await fs.readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (path.basename(file).toLowerCase() !== sha256) {
    throw new Error("evidence filename does not match content hash: " + file);
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  const encryptedSha256 = createHash("sha256")
    .update(encrypted)
    .digest("hex");

  const destination = path.join(outputDir, sha256 + ".enc");
  await fs.writeFile(destination, encrypted, { mode: 0o600 });
  artifacts.push({
    sha256,
    byteLength: bytes.length,
    encryptedFile: path.basename(destination),
    encryptedSha256,
    encryptedByteLength: encrypted.length,
    encryption: {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
    },
  });
}

const manifest = {
  kind: "EVIDENCE_STORE_BACKUP",
  encrypted: true,
  artifactCount: artifacts.length,
  artifacts,
  createdAt: new Date().toISOString(),
};
await fs.writeFile(
  path.join(outputDir, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify({
  evidenceBackup: true,
  artifactCount: artifacts.length,
  outputDir,
}));
