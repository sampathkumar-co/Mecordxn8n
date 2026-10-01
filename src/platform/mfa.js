import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function authKey() {
  const secret = String(process.env.PLATFORM_AUTH_KEY || "").trim();
  if (secret.length < 32) {
    const error = new Error("PLATFORM_AUTH_KEY must be at least 32 characters");
    error.code = "AUTH_KEY_INVALID";
    throw error;
  }
  return createHash("sha256").update(secret).digest();
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of String(text || "").toUpperCase().replace(/=+$/g, "")) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totpCode(secret, timestampMs = Date.now()) {
  const counter = Math.floor(timestampMs / 30_000);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(number % 1_000_000).padStart(6, "0");
}

export function generateTotpCode(secret, now = Date.now()) {
  return totpCode(secret, now);
}

export function verifyTotpCode(secret, code, now = Date.now()) {
  const candidate = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(candidate)) return false;
  return [-1, 0, 1].some((window) =>
    safeEqual(totpCode(secret, now + window * 30_000), candidate)
  );
}

function encryptSecret(userId, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", authKey(), iv);
  cipher.setAAD(Buffer.from(`${userId}:totp:v1`));
  const ciphertext = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSecret(row) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    authKey(),
    Buffer.from(row.totp_iv, "base64"),
  );
  decipher.setAAD(Buffer.from(`${row.user_id}:totp:v1`));
  decipher.setAuthTag(Buffer.from(row.totp_tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(row.totp_ciphertext, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function recoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = randomBytes(8).toString("hex").toUpperCase();
    return raw.slice(0, 8) + "-" + raw.slice(8);
  });
}

export async function beginTotpEnrollment(client, { userId, email }) {
  const secret = base32Encode(randomBytes(20));
  const encrypted = encryptSecret(userId, secret);
  const recovery = recoveryCodes();
  const hashes = recovery.map(sha256);
  await client.query(
    `INSERT INTO platform_user_mfa (
       user_id, totp_ciphertext, totp_iv, totp_tag,
       recovery_code_hashes, enabled_at, pending_expires_at, updated_at
     )
     VALUES ($1,$2,$3,$4,$5,NULL,now() + interval '10 minutes',now())
     ON CONFLICT (user_id) DO UPDATE SET
       totp_ciphertext = EXCLUDED.totp_ciphertext,
       totp_iv = EXCLUDED.totp_iv,
       totp_tag = EXCLUDED.totp_tag,
       recovery_code_hashes = EXCLUDED.recovery_code_hashes,
       enabled_at = NULL,
       pending_expires_at = EXCLUDED.pending_expires_at,
       updated_at = now()`,
    [userId, encrypted.ciphertext, encrypted.iv, encrypted.tag, hashes],
  );
  const label = encodeURIComponent(String(email || userId));
  const issuer = encodeURIComponent("Mecordxn8n");
  return {
    secret,
    otpauthUri:
      `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`,
    recoveryCodes: recovery,
    expiresInSeconds: 600,
  };
}

export async function confirmTotpEnrollment(client, { userId, code }) {
  const result = await client.query(
    `SELECT * FROM platform_user_mfa
      WHERE user_id = $1
      FOR UPDATE`,
    [userId],
  );
  if (result.rowCount === 0) return false;
  const row = result.rows[0];
  if (
    !row.pending_expires_at ||
    new Date(row.pending_expires_at).getTime() <= Date.now()
  ) {
    return false;
  }
  if (!verifyTotpCode(decryptSecret(row), code)) return false;
  await client.query(
    `UPDATE platform_user_mfa
        SET enabled_at = now(),
            pending_expires_at = NULL,
            updated_at = now()
      WHERE user_id = $1`,
    [userId],
  );
  return true;
}

export async function disableTotp(client, userId) {
  await client.query("DELETE FROM platform_user_mfa WHERE user_id = $1", [userId]);
  await client.query(
    "UPDATE platform_sessions SET mfa_verified_at = NULL WHERE user_id = $1",
    [userId],
  );
}

export async function verifyUserMfa(client, { userId, code }) {
  const result = await client.query(
    `SELECT * FROM platform_user_mfa
      WHERE user_id = $1
        AND enabled_at IS NOT NULL
      FOR UPDATE`,
    [userId],
  );
  if (result.rowCount === 0) {
    return { required: false, verified: true };
  }
  if (!code) return { required: true, verified: false };

  const row = result.rows[0];
  const candidate = String(code).trim();
  if (verifyTotpCode(decryptSecret(row), candidate)) {
    return { required: true, verified: true, recoveryUsed: false };
  }

  const digest = sha256(candidate.toUpperCase());
  const hashes = row.recovery_code_hashes || [];
  const index = hashes.findIndex((hash) => safeEqual(hash, digest));
  if (index < 0) return { required: true, verified: false };

  const remaining = hashes.filter((_, itemIndex) => itemIndex !== index);
  await client.query(
    `UPDATE platform_user_mfa
        SET recovery_code_hashes = $2,
            updated_at = now()
      WHERE user_id = $1`,
    [userId, remaining],
  );
  return { required: true, verified: true, recoveryUsed: true };
}

export async function getMfaStatus(client, userId) {
  const result = await client.query(
    `SELECT enabled_at, pending_expires_at,
            cardinality(recovery_code_hashes) AS recovery_codes_remaining
       FROM platform_user_mfa
      WHERE user_id = $1`,
    [userId],
  );
  if (result.rowCount === 0) {
    return { enabled: false, pending: false, recoveryCodesRemaining: 0 };
  }
  const row = result.rows[0];
  return {
    enabled: Boolean(row.enabled_at),
    pending:
      !row.enabled_at &&
      Boolean(row.pending_expires_at) &&
      new Date(row.pending_expires_at).getTime() > Date.now(),
    recoveryCodesRemaining: Number(row.recovery_codes_remaining || 0),
  };
}
