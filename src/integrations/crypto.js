import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

function keyFromSecret(secret) {
  const value = String(secret || "");
  if (value.length < 32) {
    const error = new Error("integration encryption key must be at least 32 characters");
    error.code = "MASTER_KEY_INVALID";
    throw error;
  }
  return createHash("sha256").update(value).digest();
}

function normalizedVersion(value) {
  const version = Number(value || 1);
  if (!Number.isInteger(version) || version < 1 || version > 9999) {
    const error = new Error("integration key version is invalid");
    error.code = "MASTER_KEY_VERSION_INVALID";
    throw error;
  }
  return version;
}

export function activeIntegrationKeyVersion(env = process.env) {
  return normalizedVersion(env.PLATFORM_MASTER_KEY_ACTIVE_VERSION || 1);
}

export function integrationKeyForVersion(version, env = process.env) {
  const normalized = normalizedVersion(version);
  const versioned = String(env[`PLATFORM_MASTER_KEY_V${normalized}`] || "").trim();
  if (versioned) return versioned;
  if (normalized === 1) {
    const legacy = String(env.PLATFORM_MASTER_KEY || "").trim();
    if (legacy) return legacy;
  }
  const error = new Error(
    `integration encryption key version ${normalized} is not configured`,
  );
  error.code = "MASTER_KEY_VERSION_MISSING";
  throw error;
}

export function encryptIntegrationConfig({
  config,
  workspaceId,
  provider,
  masterKey = null,
  version = null,
  env = process.env,
}) {
  const resolvedVersion = normalizedVersion(
    version ?? (masterKey ? 1 : activeIntegrationKeyVersion(env)),
  );
  const key = keyFromSecret(
    masterKey || integrationKeyForVersion(resolvedVersion, env),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${workspaceId}:${provider}:v${resolvedVersion}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(config), "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    version: resolvedVersion,
  };
}

export function decryptIntegrationConfig({
  ciphertext,
  iv,
  tag,
  workspaceId,
  provider,
  version = 1,
  masterKey = null,
  env = process.env,
}) {
  const resolvedVersion = normalizedVersion(version);
  const key = keyFromSecret(
    masterKey || integrationKeyForVersion(resolvedVersion, env),
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64"),
  );
  decipher.setAAD(Buffer.from(`${workspaceId}:${provider}:v${resolvedVersion}`));
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
