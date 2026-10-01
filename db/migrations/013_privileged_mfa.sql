ALTER TABLE platform_sessions
  ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS platform_user_mfa (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  totp_ciphertext text NOT NULL,
  totp_iv text NOT NULL,
  totp_tag text NOT NULL,
  recovery_code_hashes text[] NOT NULL DEFAULT '{}',
  enabled_at timestamptz,
  pending_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
