ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS password_version smallint NOT NULL DEFAULT 1;

ALTER TABLE platform_sessions
  ADD COLUMN IF NOT EXISTS csrf_hash text;

CREATE INDEX IF NOT EXISTS idx_platform_sessions_user_active
  ON platform_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;
