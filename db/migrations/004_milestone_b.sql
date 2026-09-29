ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_state_check;

ALTER TABLE jobs
  ADD CONSTRAINT jobs_state_check CHECK (state IN (
    'QUEUED',
    'RUNNING',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'DEAD_LETTER'
  ));

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 3
    CHECK (max_attempts BETWEEN 1 AND 10),
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS cost_units numeric(12,4) NOT NULL DEFAULT 0
    CHECK (cost_units >= 0);

CREATE INDEX IF NOT EXISTS jobs_retry_idx
  ON jobs(state, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  finding_id uuid REFERENCES findings(id) ON DELETE CASCADE,
  report_id uuid REFERENCES reports(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN (
    'SOURCE_REMEDIATION',
    'REPORT_RELEASE'
  )),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'EXPIRED'
  )),
  requested_by text NOT NULL DEFAULT 'system',
  decided_by text,
  decision_note text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX IF NOT EXISTS approval_requests_pending_idx
  ON approval_requests(status, expires_at, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS approval_one_pending_remediation
  ON approval_requests(finding_id, action_type)
  WHERE status = 'PENDING' AND action_type = 'SOURCE_REMEDIATION';

CREATE TABLE IF NOT EXISTS monitoring_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  name text NOT NULL,
  capability text NOT NULL CHECK (capability IN (
    'PUBLIC_HTTP_OBSERVE',
    'BROWSER_QA'
  )),
  requested_url text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  cadence_minutes integer NOT NULL CHECK (cadence_minutes BETWEEN 5 AND 10080),
  enabled boolean NOT NULL DEFAULT true,
  daily_budget_units numeric(12,4) NOT NULL DEFAULT 100
    CHECK (daily_budget_units > 0),
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS monitoring_policies_due_idx
  ON monitoring_policies(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS monitoring_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES monitoring_policies(id) ON DELETE CASCADE,
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  state text NOT NULL CHECK (state IN ('BASELINE', 'HEALTHY', 'REGRESSION', 'FAILED')),
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint text NOT NULL,
  cost_units numeric(12,4) NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS monitoring_runs_policy_idx
  ON monitoring_runs(policy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS regressions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id uuid NOT NULL REFERENCES monitoring_policies(id) ON DELETE CASCADE,
  monitoring_run_id uuid NOT NULL REFERENCES monitoring_runs(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  summary text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'DISMISSED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS regressions_one_open_fingerprint
  ON regressions(policy_id, fingerprint)
  WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS regressions_open_idx
  ON regressions(policy_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS repair_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_key text NOT NULL UNIQUE,
  category text NOT NULL,
  root_cause_key text,
  symptom_signature text NOT NULL,
  successful_strategy jsonb NOT NULL DEFAULT '{}'::jsonb,
  validation_strategy jsonb NOT NULL DEFAULT '{}'::jsonb,
  success_count integer NOT NULL DEFAULT 0,
  failure_count integer NOT NULL DEFAULT 0,
  last_outcome text CHECK (last_outcome IN ('SUCCESS', 'FAILED', 'PARTIAL')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repair_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  remediation_request_id uuid NOT NULL REFERENCES remediation_requests(id) ON DELETE CASCADE,
  finding_id uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  pattern_key text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('SUCCESS', 'FAILED', 'PARTIAL')),
  summary text NOT NULL,
  lessons jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS repair_outcomes_pattern_idx
  ON repair_outcomes(pattern_key, created_at DESC);

CREATE TABLE IF NOT EXISTS operational_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  component text NOT NULL,
  event_type text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('INFO', 'WARN', 'ERROR')),
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  target_id uuid REFERENCES targets(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operational_events_created_idx
  ON operational_events(created_at DESC);

CREATE TABLE IF NOT EXISTS daily_usage (
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  usage_date date NOT NULL DEFAULT CURRENT_DATE,
  cost_units numeric(12,4) NOT NULL DEFAULT 0 CHECK (cost_units >= 0),
  job_count integer NOT NULL DEFAULT 0 CHECK (job_count >= 0),
  PRIMARY KEY (target_id, usage_date)
);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_approval_id_unique
  ON jobs ((input->>'approvalId'))
  WHERE input ? 'approvalId';

CREATE UNIQUE INDEX IF NOT EXISTS monitoring_runs_job_unique
  ON monitoring_runs(job_id)
  WHERE job_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS repair_outcomes_request_unique
  ON repair_outcomes(remediation_request_id);
