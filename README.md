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
