import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

function keyFromSecret(secret) {
  const value = String(secret || "");
  if (value.length < 32) {
    const error = new Error("PLATFORM_MASTER_KEY must be at least 32 characters");
    error.code = "MASTER_KEY_INVALID";
    throw error;
  }
  return createHash("sha256").update(value).digest();
}

export function encryptIntegrationConfig({
  config,
  workspaceId,
  provider,
  masterKey = process.env.PLATFORM_MASTER_KEY,
}) {
  const key = keyFromSecret(masterKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${workspaceId}:${provider}:v1`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    version: 1,
  };
}

export function decryptIntegrationConfig({
  ciphertext,
  iv,
  tag,
  workspaceId,
  provider,
  masterKey = process.env.PLATFORM_MASTER_KEY,
}) {
  const key = keyFromSecret(masterKey);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAAD(Buffer.from(`${workspaceId}:${provider}:v1`));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function configFingerprint(config) {
  return createHash("sha256")
    .update(JSON.stringify(config))
    .digest("hex")
    .slice(0, 16);
}
