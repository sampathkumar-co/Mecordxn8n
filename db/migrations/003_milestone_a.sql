ALTER TABLE findings
  ADD COLUMN IF NOT EXISTS root_cause_key text,
  ADD COLUMN IF NOT EXISTS verification_state text NOT NULL DEFAULT 'UNVERIFIED'
    CHECK (verification_state IN ('UNVERIFIED', 'VERIFYING', 'VERIFIED', 'NOT_REPRODUCED')),
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;

CREATE TABLE IF NOT EXISTS site_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  url text NOT NULL,
  source text NOT NULL DEFAULT 'discovery',
  status_code integer,
  title text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, url)
);

CREATE INDEX IF NOT EXISTS site_pages_target_idx
  ON site_pages(target_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS journey_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  name text NOT NULL,
  state text NOT NULL CHECK (state IN ('PASSED', 'FAILED', 'PARTIAL')),
  steps jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS journey_runs_target_idx
  ON journey_runs(target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS finding_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('VERIFIED', 'NOT_REPRODUCED', 'INCONCLUSIVE')),
  attempts integer NOT NULL CHECK (attempts > 0),
  matched_attempts integer NOT NULL CHECK (matched_attempts >= 0),
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finding_verifications_finding_idx
  ON finding_verifications(finding_id, created_at DESC);

CREATE TABLE IF NOT EXISTS evidence_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  finding_id uuid REFERENCES findings(id) ON DELETE CASCADE,
  verification_id uuid REFERENCES finding_verifications(id) ON DELETE CASCADE,
  kind text NOT NULL,
  path text,
  sha256 text,
  byte_length bigint,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evidence_artifacts_finding_idx
  ON evidence_artifacts(finding_id, created_at DESC);

CREATE TABLE IF NOT EXISTS finding_intelligence (
  finding_id uuid PRIMARY KEY REFERENCES findings(id) ON DELETE CASCADE,
  business_impact_score integer NOT NULL CHECK (business_impact_score BETWEEN 0 AND 100),
  buyer_relevance integer NOT NULL CHECK (buyer_relevance BETWEEN 0 AND 100),
  repair_feasibility integer NOT NULL CHECK (repair_feasibility BETWEEN 0 AND 100),
  engineering_effort integer NOT NULL CHECK (engineering_effort BETWEEN 1 AND 100),
  opportunity_score numeric(6,2) NOT NULL CHECK (opportunity_score BETWEEN 0 AND 100),
  impact_tier text NOT NULL CHECK (impact_tier IN ('LOW', 'MEDIUM', 'HIGH')),
  affected_journey text,
  rationale text NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS finding_intelligence_opportunity_idx
  ON finding_intelligence(opportunity_score DESC);

CREATE TABLE IF NOT EXISTS remediation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  finding_id uuid NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  project_root text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED')),
  mcp_request_id uuid,
  mcp_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS remediation_requests_finding_idx
  ON remediation_requests(finding_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('CLIENT_PROPOSAL', 'TECHNICAL_REPORT')),
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'APPROVED', 'ARCHIVED')),
  markdown text NOT NULL,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reports_target_idx
  ON reports(target_id, created_at DESC);
