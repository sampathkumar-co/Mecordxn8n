CREATE TABLE IF NOT EXISTS integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN (
    'GITHUB','SLACK','STRIPE','WEBHOOK'
  )),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DISABLED','ERROR')),
  config_ciphertext text NOT NULL,
  config_iv text NOT NULL,
  config_tag text NOT NULL,
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  subscribed_events text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_name_unique
  ON integration_connections(workspace_id, lower(name));

CREATE INDEX IF NOT EXISTS integration_connections_workspace_idx
  ON integration_connections(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN (
      'PENDING','RUNNING','SENT','FAILED','DEAD_LETTER','CANCELLED'
    )),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  next_attempt_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  last_error_code text,
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS integration_outbox_claim_idx
  ON integration_outbox(state, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS integration_outbox_workspace_idx
  ON integration_outbox(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  provider_event_id text,
  event_type text NOT NULL,
  payload_sha256 text NOT NULL,
  signature_valid boolean NOT NULL,
  processed_state text NOT NULL DEFAULT 'RECORDED'
    CHECK (processed_state IN ('RECORDED','PROCESSED','IGNORED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_webhook_event_unique
  ON integration_webhook_receipts(connection_id, provider_event_id)
  WHERE provider_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS integration_webhook_receipts_idx
  ON integration_webhook_receipts(connection_id, created_at DESC);
