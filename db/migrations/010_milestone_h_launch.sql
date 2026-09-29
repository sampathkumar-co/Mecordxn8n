ALTER TABLE platform_users
  ADD COLUMN IF NOT EXISTS is_platform_operator boolean NOT NULL DEFAULT false;

ALTER TABLE workspace_subscriptions
  ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS workspace_onboarding (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'IN_PROGRESS'
    CHECK (status IN ('IN_PROGRESS','FINALIZING','READY','BLOCKED')),
  completed_steps text[] NOT NULL DEFAULT '{}',
  finalization_attempts integer NOT NULL DEFAULT 0 CHECK (finalization_attempts >= 0),
  last_error_code text,
  primary_target_id uuid REFERENCES targets(id) ON DELETE SET NULL,
  first_http_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  first_browser_job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  first_report_id uuid REFERENCES reports(id) ON DELETE SET NULL,
  blocked_reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS domain_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  hostname text NOT NULL,
  method text NOT NULL DEFAULT 'DNS_TXT'
    CHECK (method IN ('DNS_TXT')),
  challenge text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','VERIFIED','EXPIRED','REVOKED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error_code text,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS domain_verifications_one_pending
  ON domain_verifications(target_id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS domain_verifications_workspace_idx
  ON domain_verifications(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS report_share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  last_accessed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS report_share_links_workspace_idx
  ON report_share_links(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('TEAM','BUSINESS','ENTERPRISE')),
  provider text NOT NULL DEFAULT 'STRIPE' CHECK (provider IN ('STRIPE')),
  provider_session_id text NOT NULL UNIQUE,
  provider_customer_id text,
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','COMPLETE','EXPIRED')),
  checkout_url text,
  expires_at timestamptz,
  created_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS billing_checkout_sessions_workspace_idx
  ON billing_checkout_sessions(workspace_id, created_at DESC);


UPDATE platform_users
   SET is_platform_operator = true
 WHERE id = (
   SELECT u.id
     FROM platform_users u
     JOIN workspace_memberships m ON m.user_id = u.id
    WHERE m.role = 'OWNER'
    ORDER BY u.created_at
    LIMIT 1
 )
   AND NOT EXISTS (
     SELECT 1 FROM platform_users WHERE is_platform_operator = true
   );

CREATE TABLE IF NOT EXISTS platform_public_rate_buckets (
  key_hash text NOT NULL,
  bucket_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (key_hash, bucket_start)
);
