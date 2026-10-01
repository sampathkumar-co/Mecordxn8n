ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

-- Existing accounts predate verification delivery. Preserve their access while
-- requiring verification for accounts created after this migration.
UPDATE platform_users
   SET email_verified_at = COALESCE(email_verified_at, created_at, now())
 WHERE email_verified_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('EMAIL_VERIFY','PASSWORD_RESET')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_auth_tokens_one_active
  ON platform_auth_tokens (user_id, kind)
  WHERE consumed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_platform_auth_tokens_expiry
  ON platform_auth_tokens (expires_at)
  WHERE consumed_at IS NULL;
