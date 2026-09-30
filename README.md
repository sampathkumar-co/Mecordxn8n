# Mecord × n8n

Mecord × n8n is an authorization-gated **Problem → Proof → Repair → Revenue** orchestration system for website quality engineering.

## Runtime split

- **n8n** — durable schedules, retries, maintenance ticks, and cross-service orchestration.
- **Control API + PostgreSQL** — authorization, jobs, leases, approvals, monitoring, findings, verification, evidence, repair intelligence, reports, budgets, and audit/operational history.
- **Browser/HTTP workers** — bounded public QA and continuous monitoring execution.
- **Mecord Connect MCP** — client-authorized source remediation.
- **ChatGPT** — architecture, debugging, implementation, review, and further engineering.

## Milestone A — revenue-capable MVP

Milestone A provides the initial target → finding → verification → opportunity → proposal → authorized remediation flow:

- exact-host authorization registry,
- public HTTP and safe Playwright QA,
- site discovery,
- read-only journeys,
- finding deduplication,
- independent verification,
- evidence artifacts,
- business-impact/opportunity scoring,
- Mecord MCP remediation bridge,
- client proposal generation.

## Milestone B — production hardening

Milestone B adds the operational controls required to run that loop continuously.

### Human approval gates

Source remediation can no longer be queued through the generic job endpoint.

The supported path is:

```text
VERIFIED finding
      ↓
request remediation
      ↓
PENDING approval
      ↓
explicit human APPROVE / REJECT
      ↓
re-check current target authorization
      ↓
queue SOURCE_REMEDIATION
```

Approval requests expire and are idempotent. Replaying an already approved remediation request does not create another job. Client reports use the same release-approval mechanism and remain local until explicitly approved.

### Continuous regression monitoring

A target can have recurring HTTP or browser monitoring policies with:

- exact authorized URL,
- cadence from 5 minutes to 7 days,
- bounded input,
- daily cost-unit budget,
- enabled/disabled state,
- durable next/last run timestamps.

n8n runs the production maintenance workflow every five minutes. Due policies are claimed atomically with `FOR UPDATE SKIP LOCKED`, so concurrent ticks cannot queue the same monitor twice.

The first successful run creates a baseline. Later runs compare normalized snapshots and open regressions for:

- HTTP/page availability changes,
- major latency/load-duration increases,
- new runtime errors,
- new failed requests,
- new broken images,
- new horizontal overflow.

A healthy later snapshot resolves open regressions.

### Repair intelligence

Successful authorized remediations update a reusable repair-pattern store containing:

- anonymized symptom hash,
- category/root-cause class,
- success/failure counts,
- validation metadata,
- structural result shape.

Raw client MCP output, code, paths, URLs, and error text are not copied into cross-client repair memory.

When a future verified issue in the same category reaches remediation, up to five successful repair patterns are supplied to Mecord as **non-authoritative hints**. Mecord must still inspect the actual project and validate the repair.

### Reliability and failure containment

Jobs now support:

- configurable 1–10 maximum attempts,
- exponential retry backoff,
- lease heartbeats,
- dead-letter state after retry exhaustion,
- authorization re-check at lease and heartbeat time,
- cancellation of queued jobs after authorization expiry/revocation,
- one active job per target,
- worker-write lease ownership,
- context binding between jobs and monitoring/repair records.

Long-running Mecord remediation heartbeats its lease every minute.

### Budgets and observability

Continuous monitors consume cost units. Policies stop queueing runs after their configured daily budget is reached.

Operational state is available at:

`GET /v1/ops/metrics`

including:

- jobs by state,
- pending approvals,
- enabled/due monitors,
- open regressions,
- last-24-hour operational errors,
- today's job count and cost units.

## Milestone C — consent-safe revenue operations

Milestone C closes the commercial lifecycle without turning the product into an autonomous cold-outreach system.

The supported lifecycle is:

```text
VERIFIED finding
      ↓
commercial opportunity
      ↓
released client report
      ↓
known contact + affirmative consent/client relationship
      ↓
draft outbound action
      ↓
human approval
      ↓
re-check consent + release + cooldown + daily cap
      ↓
APPROVED manual/provider handoff
      ↓
delivery/response recorded
      ↓
contract/invoice/payment evidence
      ↓
revenue attribution
      ↓
optional recurring service + renewal tracking
```

Key controls:

- commercial opportunities are anchored to verified findings and are deduplicated per target/finding;
- `WON` cannot be set manually and is reached only after a recorded `RECEIVED` revenue event;
- external reports must already be `APPROVED` before they can be referenced by an outbound action;
- contacts require explicit `OPTED_IN` or `CLIENT_RELATIONSHIP` state, evidence, and non-expired consent before activation;
- opt-out / do-not-contact state immediately suppresses future pending or approved actions;
- every outbound action is a draft until an explicit `OUTBOUND_CONTACT` approval is granted;
- approval alone is not permission forever: consent, report release, cooldown, and daily activation cap are re-checked at activation time;
- delivery is **recorded**, not automatically executed by this repository. No provider-specific cold-send worker is included;
- payment/refund records use minor currency units, currency consistency, and idempotency references;
- received/refunded revenue requires a traceable external reference;
- recurring services can be paused/cancelled/ended and surface upcoming renewals;
- commercial maintenance only returns due follow-ups, renewals, and approved manual actions. It does not send messages.

Commercial state is available through the `/v1/commercial-*`, `/v1/outbound-actions/*`, `/v1/revenue/metrics`, and `/v1/services/*` APIs.

## n8n workflows

Workflow JSON under `n8n/workflows/` includes:

- job intake,
- public HTTP dispatch,
- browser QA dispatch,
- site discovery dispatch,
- journey QA dispatch,
- finding verification dispatch,
- remediation dispatch,
- production maintenance tick.

Workflow definitions remain inactive on import. Review environment variables, authorization scope, cadence, and budgets before activating them.

## Local stack

```bash
cp .env.example .env
docker compose up --build
```

The remediation worker requires a real authorized Mecord Streamable HTTP MCP endpoint before source-remediation jobs can succeed.

## Safety boundary

Public QA remains non-interactive: no clicking, typing, form submission, login automation, destructive methods, non-web ports, private/reserved destinations, or out-of-scope navigation.

Security-capable work remains limited to explicitly authorized client/bounty scope. No proposal/report is automatically delivered to a third party.

## Milestone B hardening guarantees

Milestone B is enforced at the Control API/PostgreSQL boundary, not by trusting n8n or workers.

- Monitoring policies are claimed with row locks and are single-flight per policy while a monitor job is queued or running.
- Monitoring cost is derived server-side from the authorized capability. Successful and terminal failed runs are counted once against a UTC-day policy budget.
- Dead-lettered monitor jobs that could not report their own failure are reconciled into one bounded `FAILED` monitoring run.
- Regression comparison anchors to the latest `BASELINE`/`HEALTHY` snapshot. Persistent signals keep one stable fingerprint; partial recovery resolves only the signals that recovered.
- Repair memory is sanitized again by the Control API. Raw source, paths, URLs, errors, credentials, client identifiers, MCP response values, and raw MCP object keys are not accepted into cross-client memory.
- Source remediation approval replay is idempotent under concurrency. Current authorization is revalidated before queueing, and running jobs are cancelled when authorization becomes invalid.
- Remediation workers renew their lease before and during Mecord execution. Lease/authorization loss aborts the client-side MCP request.
- `GET /livez` is process liveness. `GET /healthz` is database-backed readiness.
- Migration `005_milestone_b_hardening.sql` adds the budget bound and indexes/uniqueness used by these guarantees.


## V1 productization

The V1 release candidate adds the product and operations layer around Milestones A-C.

### Control Center

The built-in web console is served at `/console` and provides a compact multi-workspace control surface for targets, findings, evidence, approvals, commercial pipeline, operations, integrations, members, API keys, subscription/usage, retention and audit data.

### Multi-tenant SaaS controls

V1 adds:

- isolated workspaces and workspace-bound targets;
- OWNER / ADMIN / OPERATOR / VIEWER roles;
- invite-only membership;
- salted scrypt password hashing, session revocation, login lockout and bounded sessions;
- scoped API keys with rate limits and expiry/revocation;
- plan quotas and monthly usage accounting;
- workspace subscriptions and Stripe subscription ingestion;
- retention controls and workspace deletion;
- workspace security/audit events.

Legacy operator-token routes remain available for trusted internal orchestration. Customer-facing product access uses the platform workspace boundary.

### Integrations

Integration configuration is encrypted at rest with AES-256-GCM using `PLATFORM_MASTER_KEY` and workspace/provider-bound AAD.

Supported V1 providers:

- GitHub — outbound issue creation and signed inbound webhook receipts;
- Slack — outbound webhook notifications;
- generic HTTPS webhook — public-address-only destination with HMAC event signing;
- Stripe — signed inbound subscription lifecycle events.

Product events are placed in a durable, workspace-scoped outbox with idempotency keys, leases, retry/backoff and dead-letter handling. n8n triggers the integration worker; n8n does not decrypt provider credentials or decide permissions.

Events include verified findings, pending approvals, opened regressions, successful authorized remediation, received revenue and service renewals. Event payloads contain bounded product identifiers/state rather than raw source files, MCP responses or credentials.

### Release certification

A V1 candidate is not considered release-ready merely because unit tests pass. GitHub Actions enforces three gates:

1. **CI** — migrations, syntax/JSON validation, complete Node test suite, Compose validation, browser image build.
2. **Security** — high-severity dependency audit, repository secret scan, control-image build and HIGH/CRITICAL Trivy scan.
3. **Release Gate** — CI checks again, synthetic performance benchmark, PostgreSQL 17 database backup, clean-database restore verification, release manifest generation, Compose validation, and production image builds.

Release artifacts include `release-certification.json` and the database backup manifest (SHA-256 + byte length). The database backup itself is intentionally not uploaded by CI.

### Disaster recovery

`npm run backup:db` creates a PostgreSQL custom-format dump and checksum manifest.

`npm run restore:verify` restores that dump into a clean database supplied through `RESTORE_DATABASE_URL` and verifies the canonical A-C + platform/integration tables exist.

Production operators should store database dumps and the artifact volume in a separately secured backup destination and periodically run restore verification against an isolated database.

### Production prerequisites

The repository can certify the software and deployment definition, but it cannot manufacture live production credentials or customer accounts. A real deployment still requires operator-provided secrets/infrastructure such as PostgreSQL credentials, n8n encryption key, platform master/bootstrap keys, Mecord MCP credentials, DNS/TLS/reverse proxy configuration, backup storage, and any GitHub/Slack/Stripe/webhook credentials selected by a workspace.


## Milestone H — production launch and revenue activation

Milestone H turns the certified engineering platform into a customer-operable launch flow.

### Self-serve first value

A new customer can now:

```text
sign up
  → 14-day Team trial
  → register a non-destructive target
  → run authorized HTTP / browser QA
  → receive a first READY report
  → request human report release
  → create an expiring secure share link
```

The Control Center has a dedicated **Launch** view with the onboarding checklist, subscription state, workspace health, billing entry points, ownership verification and first-assessment actions.

Self-serve target registration intentionally cannot start in `CLIENT_AUTHORIZED` mode and cannot request `SOURCE_REMEDIATION`. Those privileges are enabled only through the Authorization Center after target-domain ownership is verified.

### Ownership and authorization center

For a target, an ADMIN can create a short-lived DNS TXT challenge:

- record name: `_mecordxn8n.<target-host>`
- value: the generated `mecordxn8n-verification=...` challenge
- challenge lifetime: 30 minutes

After the DNS proof succeeds, the workspace may replace the target authorization with a bounded `CLIENT_AUTHORIZED` grant and explicitly include source-remediation capability.

Authorization history remains visible. Revoking the active authorization also cancels queued/running jobs and clears their leases.

DNS ownership is an additional trust signal for self-serve privileged access; it does not replace the existing requirement for a verified finding, explicit source-remediation capability, human approval and current authorization before remediation execution.

### Billing and trials

Self-serve signup creates a 14-day Team trial. Operational write scopes fail closed after the trial expires or when Stripe marks the workspace `PAST_DUE` / cancelled. Read-only product access and billing access remain available so the owner can inspect the account and recover billing.

Stripe Checkout and Customer Portal are Stripe-hosted. Payment-card data does not pass through the Mecordxn8n Control API.

Supported launch billing events include:

- Checkout completion
- subscription create/update/delete
- invoice payment success
- invoice payment failure

The billing endpoints remain unavailable with a safe dependency/configuration response until production Stripe keys and price IDs are supplied.

### First-assessment finalization

The first assessment uses only capabilities that are already authorized for the target. It never adds source access.

The inactive-on-import n8n `onboarding-finalization.json` workflow calls the Control API once per minute. The Control API atomically claims completed onboarding assessments with `FOR UPDATE SKIP LOCKED`, generates at most one initial client report, retries bounded finalization failures and blocks after repeated failures.

Generated reports are `READY`, not externally released. External sharing still requires the canonical human `REPORT_RELEASE` approval.

### Secure report sharing

Only an `APPROVED` report can receive a public share token.

Share tokens:

- are random and returned only at creation time;
- are stored only as SHA-256 hashes;
- have bounded expiry;
- can be revoked immediately;
- stop working if the report is no longer approved.

Public share access exposes the approved report, not workspace authorization evidence, credentials or private MCP/source data.

### Customer and operator health

Each workspace exposes a customer-facing health summary covering:

- recent job states;
- failing monitors;
- integration delivery states/dead letters;
- pending approvals;
- open regressions.

A separate platform-operator view provides fleet-level workspace/subscription counts and active operational alerts. Ordinary workspace ownership does not imply platform-operator access.

### Production deployment

The repository includes:

- `docker-compose.production.yml` — production overlay;
- `deploy/Caddyfile` — automatic TLS and an explicit public-route allowlist for the customer app;
- n8n remains private by default on the host/Compose network and is not published through Caddy;
- `npm run production:preflight` — rejects missing/placeholder/short production secrets and invalid HTTPS/domain configuration;
- `npm run production:smoke` — verifies TLS/security headers, public liveness, the Control Center, and that internal worker/maintenance/readiness routes are not exposed.

Typical production validation:

```bash
npm run production:preflight
docker compose -f docker-compose.yml -f docker-compose.production.yml config
docker compose -f docker-compose.yml -f docker-compose.production.yml up -d
npm run production:smoke
```

Production deployment still requires operator-provided DNS, reachable infrastructure, strong secrets, database credentials, backup storage, and any selected Stripe/Mecord/provider credentials. Repository certification does not claim those external systems have been provisioned.


### Post-H hardening

After Milestone H, the production boundary was tightened further:

- CI and production images use deterministic `npm ci` installs from the committed lockfile;
- both built production images are scanned for HIGH/CRITICAL vulnerabilities;
- production Caddy exposes only `/console`, `/livez`, customer `/v1/platform/*` routes, and signed integration webhook ingress;
- `/healthz`, worker APIs, maintenance APIs, legacy orchestrator routes, and n8n stay private;
- production smoke checks require HTTPS and verify the internal-route boundary;
- login performs equivalent password-hash work for unknown accounts to reduce account-existence timing leakage;
- the HTTP server uses bounded request/header/keep-alive settings;
- upgrade-time platform-operator identity is reconciled to the auditable `PLATFORM_BOOTSTRAPPED` event rather than ordinary workspace ownership;
- the Control Center uses bounded request timeouts, safe GET-only transient retry, and explicit degraded/offline/retry states.

The planned Control Center redesign is documented in `docs/UI_UX_V2_PLAN.md`.
