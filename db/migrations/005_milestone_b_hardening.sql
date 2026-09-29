ALTER TABLE monitoring_policies
  DROP CONSTRAINT IF EXISTS monitoring_policies_daily_budget_bound;

ALTER TABLE monitoring_policies
  ADD CONSTRAINT monitoring_policies_daily_budget_bound
  CHECK (daily_budget_units > 0 AND daily_budget_units <= 100000);

CREATE UNIQUE INDEX IF NOT EXISTS remediation_requests_job_unique
  ON remediation_requests(job_id);

CREATE INDEX IF NOT EXISTS jobs_monitoring_policy_active_idx
  ON jobs ((input->>'monitoringPolicyId'), state)
  WHERE input ? 'monitoringPolicyId'
    AND state IN ('QUEUED','RUNNING');

CREATE INDEX IF NOT EXISTS operational_events_severity_created_idx
  ON operational_events(severity, created_at DESC);
