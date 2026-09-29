CREATE TABLE IF NOT EXISTS commercial_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  primary_finding_id uuid REFERENCES findings(id) ON DELETE SET NULL,
  source_report_id uuid REFERENCES reports(id) ON DELETE SET NULL,
  title text NOT NULL,
  state text NOT NULL DEFAULT 'NEW' CHECK (state IN (
    'NEW','QUALIFIED','ENGAGED','PROPOSAL','NEGOTIATING','WON','LOST','PAUSED'
  )),
  opportunity_score numeric(6,2) NOT NULL DEFAULT 0
    CHECK (opportunity_score BETWEEN 0 AND 100),
  estimated_value_minor bigint CHECK (
    estimated_value_minor IS NULL OR estimated_value_minor >= 0
  ),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  next_action_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commercial_opportunity_finding_unique
  ON commercial_opportunities(target_id, primary_finding_id)
  WHERE primary_finding_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS commercial_opportunities_pipeline_idx
  ON commercial_opportunities(state, next_action_at, updated_at DESC);

CREATE TABLE IF NOT EXISTS commercial_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  display_name text,
  channel text NOT NULL CHECK (channel IN ('EMAIL','PHONE','WHATSAPP','OTHER')),
  destination text NOT NULL,
  destination_hash text NOT NULL,
  consent_state text NOT NULL DEFAULT 'UNKNOWN' CHECK (consent_state IN (
    'UNKNOWN','OPTED_IN','CLIENT_RELATIONSHIP','OPTED_OUT','DO_NOT_CONTACT'
  )),
  consent_source text,
  consent_evidence text,
  consent_recorded_at timestamptz,
  consent_expires_at timestamptz,
  suppressed_at timestamptz,
  suppression_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (target_id, channel, destination_hash)
);

CREATE INDEX IF NOT EXISTS commercial_contacts_consent_idx
  ON commercial_contacts(target_id, consent_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS commercial_policies (
  target_id uuid PRIMARY KEY REFERENCES targets(id) ON DELETE CASCADE,
  daily_activation_limit integer NOT NULL DEFAULT 3
    CHECK (daily_activation_limit BETWEEN 1 AND 50),
  cooldown_hours integer NOT NULL DEFAULT 72
    CHECK (cooldown_hours BETWEEN 1 AND 720),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commercial_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES commercial_opportunities(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES commercial_contacts(id) ON DELETE CASCADE,
  report_id uuid NOT NULL REFERENCES reports(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN (
    'INITIAL_REACHOUT','FOLLOW_UP','PROPOSAL_SHARE','RENEWAL'
  )),
  channel text NOT NULL CHECK (channel IN ('EMAIL','PHONE','WHATSAPP','OTHER')),
  state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN (
    'DRAFT','PENDING_APPROVAL','APPROVED','SENT','FAILED','CANCELLED','BLOCKED'
  )),
  subject text,
  body text NOT NULL,
  approval_id uuid,
  approved_at timestamptz,
  sent_at timestamptz,
  delivered_by text,
  provider_reference text,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS commercial_actions_one_active_kind
  ON commercial_actions(opportunity_id, contact_id, kind)
  WHERE state IN ('DRAFT','PENDING_APPROVAL','APPROVED');

CREATE INDEX IF NOT EXISTS commercial_actions_target_state_idx
  ON commercial_actions(target_id, state, created_at DESC);

CREATE INDEX IF NOT EXISTS commercial_actions_contact_activity_idx
  ON commercial_actions(contact_id, approved_at DESC, sent_at DESC);

CREATE TABLE IF NOT EXISTS commercial_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id uuid NOT NULL REFERENCES commercial_actions(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES commercial_opportunities(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES commercial_contacts(id) ON DELETE CASCADE,
  response_type text NOT NULL CHECK (response_type IN (
    'REPLIED','INTERESTED','DECLINED','OPTED_OUT'
  )),
  summary text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commercial_responses_opportunity_idx
  ON commercial_responses(opportunity_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS revenue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES commercial_opportunities(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'CONTRACTED','INVOICED','RECEIVED','REFUNDED'
  )),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  external_reference text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS revenue_events_reference_unique
  ON revenue_events(opportunity_id, kind, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS revenue_events_target_idx
  ON revenue_events(target_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS service_agreements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id uuid NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  opportunity_id uuid NOT NULL REFERENCES commercial_opportunities(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN (
    'ACTIVE','PAUSED','CANCELLED','ENDED'
  )),
  amount_minor bigint CHECK (amount_minor IS NULL OR amount_minor >= 0),
  currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  renewal_at timestamptz,
  cadence_days integer CHECK (
    cadence_days IS NULL OR cadence_days BETWEEN 1 AND 3650
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS service_agreements_renewal_idx
  ON service_agreements(status, renewal_at);

ALTER TABLE approval_requests
  DROP CONSTRAINT IF EXISTS approval_requests_action_type_check;

ALTER TABLE approval_requests
  ADD CONSTRAINT approval_requests_action_type_check
  CHECK (action_type IN (
    'SOURCE_REMEDIATION',
    'REPORT_RELEASE',
    'OUTBOUND_CONTACT'
  ));

ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS commercial_action_id uuid
    REFERENCES commercial_actions(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS approval_one_pending_outbound
  ON approval_requests(commercial_action_id, action_type)
  WHERE status = 'PENDING' AND action_type = 'OUTBOUND_CONTACT';

CREATE UNIQUE INDEX IF NOT EXISTS commercial_action_approval_unique
  ON commercial_actions(approval_id)
  WHERE approval_id IS NOT NULL;

DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'commercial_actions_approval_fk'
  ) THEN
    ALTER TABLE commercial_actions
      ADD CONSTRAINT commercial_actions_approval_fk
      FOREIGN KEY (approval_id)
      REFERENCES approval_requests(id)
      ON DELETE SET NULL;
  END IF;
END
$;
