ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS jobs_lease_idx
  ON jobs(state, capability, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  first_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  last_job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  category text NOT NULL,
  title text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO', 'LOW', 'MEDIUM', 'HIGH')),
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  affected_url text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurrences integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'VERIFIED', 'RESOLVED', 'DISMISSED')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS findings_target_status_idx
  ON findings(target_id, status, last_seen_at DESC);
