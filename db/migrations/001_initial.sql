CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_name text NOT NULL,
  base_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN (
    'PUBLIC_QA_ONLY',
    'BUG_BOUNTY',
    'CLIENT_AUTHORIZED',
    'DO_NOT_TEST'
  )),
  allowed_hosts text[] NOT NULL,
  allowed_capabilities text[] NOT NULL DEFAULT '{}',
  scope_notes text,
  evidence_reference text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS authorizations_one_active_per_target
  ON authorizations(target_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  authorization_id uuid NOT NULL REFERENCES authorizations(id),
  job_type text NOT NULL,
  capability text NOT NULL,
  requested_url text NOT NULL,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED'
  )),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_target_created_idx
  ON jobs(target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS jobs_state_created_idx
  ON jobs(state, created_at);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  target_id uuid REFERENCES targets(id) ON DELETE SET NULL,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_target_created_idx
  ON audit_events(target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS audit_events_job_created_idx
  ON audit_events(job_id, created_at);
