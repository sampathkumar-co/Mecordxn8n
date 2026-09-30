ALTER TABLE integration_connections
  DROP CONSTRAINT IF EXISTS integration_connections_provider_check;

ALTER TABLE integration_connections
  ADD CONSTRAINT integration_connections_provider_check
  CHECK (provider IN (
    'GITHUB','SLACK','STRIPE','WEBHOOK'
  ));

ALTER TABLE integration_outbox
  ADD COLUMN IF NOT EXISTS response_code integer,
  ADD COLUMN IF NOT EXISTS response_sha256 text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE INDEX IF NOT EXISTS integration_outbox_lease_idx
  ON integration_outbox(state, lease_expires_at, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS platform_release_certifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  git_sha text NOT NULL,
  version text NOT NULL,
  status text NOT NULL CHECK (status IN ('PASSED','FAILED')),
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (git_sha, version)
);

CREATE TABLE IF NOT EXISTS workspace_backup_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('DATABASE','ARTIFACTS','FULL')),
  object_key text NOT NULL,
  sha256 text NOT NULL,
  byte_length bigint NOT NULL CHECK (byte_length >= 0),
  encrypted boolean NOT NULL DEFAULT false,
  restore_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_backup_manifests_idx
  ON workspace_backup_manifests(workspace_id, created_at DESC);
