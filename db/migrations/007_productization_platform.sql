CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  plan text NOT NULL DEFAULT 'FREE'
    CHECK (plan IN ('FREE','TEAM','BUSINESS','ENTERPRISE')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','DELETING')),
  retention_days integer NOT NULL DEFAULT 90
    CHECK (retention_days BETWEEN 7 AND 3650),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_unique
  ON workspaces(lower(slug));

INSERT INTO workspaces (id, name, slug, plan, status, retention_days)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'System Workspace',
  'system',
  'ENTERPRISE',
  'ACTIVE',
  3650
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE targets
  ADD COLUMN IF NOT EXISTS workspace_id uuid;

UPDATE targets
   SET workspace_id = '00000000-0000-4000-8000-000000000001'
 WHERE workspace_id IS NULL;

ALTER TABLE targets
  ALTER COLUMN workspace_id
  SET DEFAULT '00000000-0000-4000-8000-000000000001';

ALTER TABLE targets
  ALTER COLUMN workspace_id SET NOT NULL;

ALTER TABLE targets
  DROP CONSTRAINT IF EXISTS targets_workspace_fk;

ALTER TABLE targets
  ADD CONSTRAINT targets_workspace_fk
  FOREIGN KEY (workspace_id)
  REFERENCES workspaces(id)
  ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS targets_workspace_created_idx
  ON targets(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_salt text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','DISABLED')),
  failed_login_count integer NOT NULL DEFAULT 0
    CHECK (failed_login_count >= 0),
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS platform_users_email_unique
  ON platform_users(lower(email));

CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('OWNER','ADMIN','OPERATOR','VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS workspace_memberships_user_idx
  ON workspace_memberships(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent_hash text,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_sessions_active_idx
  ON platform_sessions(token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('ADMIN','OPERATOR','VIEWER')),
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invites_one_pending
  ON workspace_invites(workspace_id, lower(email))
  WHERE accepted_at IS NULL;

CREATE TABLE IF NOT EXISTS platform_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  name text NOT NULL,
  key_prefix text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{}',
  rate_limit_per_hour integer NOT NULL DEFAULT 2000
    CHECK (rate_limit_per_hour BETWEEN 60 AND 100000),
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS platform_api_keys_workspace_idx
  ON platform_api_keys(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_rate_buckets (
  principal_kind text NOT NULL CHECK (principal_kind IN ('SESSION','API_KEY')),
  principal_id uuid NOT NULL,
  bucket_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (principal_kind, principal_id, bucket_start)
);

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'FREE'
    CHECK (plan IN ('FREE','TEAM','BUSINESS','ENTERPRISE')),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','CANCELLED')),
  provider text,
  external_customer_id text,
  external_subscription_id text,
  seats integer NOT NULL DEFAULT 1 CHECK (seats BETWEEN 1 AND 10000),
  current_period_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO workspace_subscriptions (workspace_id, plan, status, seats)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'ENTERPRISE',
  'ACTIVE',
  10000
)
ON CONFLICT (workspace_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS workspace_usage_monthly (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  usage_month date NOT NULL,
  jobs_created bigint NOT NULL DEFAULT 0 CHECK (jobs_created >= 0),
  targets_created bigint NOT NULL DEFAULT 0 CHECK (targets_created >= 0),
  PRIMARY KEY (workspace_id, usage_month)
);

CREATE TABLE IF NOT EXISTS workspace_security_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO','WARN','ERROR')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_security_events_idx
  ON workspace_security_events(workspace_id, created_at DESC);
