# Architecture

## Trust boundary

The system is deliberately split into three layers:

1. **n8n** owns orchestration, retries, schedules, fan-out, and integrations.
2. **Control API** owns authorization, durable job state, worker leases, findings, and audit events.
3. **Workers / Mecord Connect / MCP** execute only jobs that have already been authorized.

No scanner or remediation worker accepts a raw target URL directly from an external caller. n8n triggers workers to lease jobs from the control API.

## Authorization modes

### PUBLIC_QA_ONLY

Permits only benign public-site quality capabilities:

- `PUBLIC_HTTP_OBSERVE`
- `BROWSER_QA`
- `PERFORMANCE_AUDIT`
- `ACCESSIBILITY_AUDIT`

### BUG_BOUNTY

Requires:

- an explicit exact host grant,
- an explicit capability grant,
- an expiry time,
- scope evidence/reference stored with the authorization.

Source-code remediation is never granted by this mode.

### CLIENT_AUTHORIZED

Requires:

- an explicit exact host grant,
- an explicit capability grant,
- an expiry time.

This is the only mode capable of granting `SOURCE_REMEDIATION`.

### DO_NOT_TEST

Rejects all job requests.

## Fail-closed rules

- Unknown authorization modes are denied.
- Unknown capabilities are denied.
- Expired authorizations are denied.
- Host grants are exact in V1; subdomains are not inferred.
- Privileged capabilities are never inferred from an authorization mode.
- Every denied and accepted job request creates an audit event.
- Workers must own a non-expired lease before writing findings or completing jobs.

## Implemented lifecycle

```text
n8n / MCP ingress
      |
      v
POST /v1/jobs
      |
      v
load active authorization
      |
      v
assertAuthorized()
   /      \
deny      allow
 |          |
audit      create QUEUED job
event      + audit event
            |
            v
        worker lease
            |
      +-----+---------------------+
      |                           |
      v                           v
PUBLIC_HTTP_OBSERVE           BROWSER_QA
      |                           |
safe GET observation      safe Chromium observation
      |                           |
      |                      egress proxy
      |                           |
      +-------------+-------------+
                    |
                    v
             findings/evidence
                    |
                    v
           complete leased job
                    |
                    v
                audit log
```

## Browser QA boundary

Browser QA is deliberately passive.

### No state-changing interaction

The browser worker does not click controls, type values, submit forms, upload files, accept downloads, or intentionally invoke state-changing endpoints. Requests other than GET, HEAD, and OPTIONS are aborted.

### Scope boundary

The requested URL must already have passed the control API authorization gate. The worker additionally blocks top-level navigation away from the exact requested origin before the browser follows it.

### Network boundary

A Playwright request pre-check is not sufficient protection because browser DNS could be resolved again after the check. Browser QA therefore routes traffic through a local egress proxy which performs the actual destination resolution before opening the upstream socket.

The proxy:

- permits ports 80 and 443 only,
- rejects a hostname if any returned address is private or reserved,
- blocks IPv4 loopback/private/link-local/documentation/reserved ranges,
- blocks IPv6 loopback, unique-local, and link-local ranges,
- rejects link-local cloud metadata addresses,
- pins the upstream socket to the vetted address,
- prevents Chromium's normal loopback proxy bypass.

### Evidence

Browser QA stores bounded evidence rather than full session recordings:

- viewport screenshot,
- screenshot SHA-256 and byte length,
- console errors,
- page runtime errors,
- same-site HTTP failures,
- same-site request failures,
- broken image samples,
- horizontal overflow,
- link/form counts,
- navigation timing,
- DOMContentLoaded/load timing,
- transfer size,
- CLS and long-task observations when available,
- requests blocked by the read-only or scope policy.

Screenshots live in the shared `artifacts_data` Docker volume. n8n mounts this volume read-only.

## Next trust transition

A finding should not be handed to remediation simply because it was observed once. The next module introduces independent verification with fresh execution context and evidence comparison. Only verified findings become eligible for authorized Mecord remediation.


## Milestone B production control plane

### Approval boundary

`SOURCE_REMEDIATION` is a two-gate capability:

1. target authorization must be `CLIENT_AUTHORIZED` and explicitly grant `SOURCE_REMEDIATION`;
2. a non-expired human approval request must be approved.

The generic job-ingress endpoint rejects direct source-remediation jobs. Approval execution re-checks the current authorization before queueing work.

### Queue reliability

Workers lease jobs with bounded ownership. The queue:

- re-checks authorization at lease time,
- serializes active work per target,
- retries failures with bounded exponential backoff,
- renews long operations with heartbeats,
- dead-letters exhausted jobs,
- cancels queued jobs whose authorization is revoked or expires.

Worker-originated evidence, monitoring, and learning writes require the caller to own the active lease and are bound to the IDs recorded in that job's input.

### Continuous monitoring

The maintenance tick atomically claims due monitoring policies. A monitor job uses the ordinary authorized HTTP/browser capability; there is no separate bypass capability.

Normalized snapshots deliberately contain bounded health signals rather than full page/session content. Regressions are opened only for deterioration from the previous successful snapshot and resolved after recovery.

### Repair intelligence isolation

Cross-client repair memory stores non-reversible symptom signatures and structural success metadata only. Raw MCP results remain attached to the original remediation request and do not enter the reusable pattern table.

### Operational visibility

`operational_events` stores bounded system events such as dead letters, monitor failures, regression detection, budget skips, and queue failures. `daily_usage` records per-target cost units for budget/operations reporting.

### Milestone B failure and concurrency model

The Control API is the policy enforcement point. n8n may trigger `/v1/monitoring/tick`, but cannot bypass authorization, approvals, budgets, leases, or scope checks.

A monitoring policy has at most one queued/running job. Policy claims use `FOR UPDATE SKIP LOCKED`; successful and failed monitoring executions are deduplicated by job ID and charged from server-known capability cost. Terminal worker crashes are reconciled after dead-lettering so failure loops cannot evade policy budgets.

Regression state is compared with the most recent non-regressed baseline/healthy snapshot. Signal fingerprints are stable across changing counts/latencies, allowing persistent regressions to update one open record while independently recovered signals are resolved.

Repair intelligence crosses clients only after Control API sanitization. Symptom material and root-cause keys are hashed; result structure is reduced to bounded type/count metadata. Worker-supplied raw fields are discarded.

For remediation, human approval is necessary but not sufficient: the finding must still be verified and current CLIENT_AUTHORIZED scope must still permit SOURCE_REMEDIATION. Lease heartbeat loss aborts the MCP client request; authorization invalidation cancels queued and running jobs and clears their leases.

## Milestone C commercial trust boundary

Milestone C adds commercial state without changing the security authorization boundary used by QA/remediation.

### Consent is separate from target authorization

A target being safe to inspect does not authorize contacting a person. Commercial activation therefore requires a separate contact record with current `OPTED_IN` or `CLIENT_RELATIONSHIP` consent. Unknown, expired, opted-out, suppressed, or do-not-contact records fail closed.

Consent withdrawal locks the contact before actions, blocks draft/pending/approved actions, and expires pending outbound approvals. Delivery and response paths lock contact/action rows in the same order to avoid consent/delivery deadlocks.

### Outbound approval is necessary but not sufficient

`OUTBOUND_CONTACT` reuses the canonical `approval_requests` table. A human approval does not bypass:

- contact consent/suppression,
- released-report status,
- target/contact/report context binding,
- per-contact cooldown,
- per-target UTC-day activation cap.

The policy row is locked while activation is checked so concurrent approvals cannot exceed the daily cap.

This repository contains no email/WhatsApp/phone provider dispatcher. An approved action is a durable handoff that may later be delivered manually or by a separately configured provider integration; the delivery result is recorded explicitly.

### Commercial and revenue truth

Commercial opportunities are anchored to latest-verified findings. The pipeline can be managed through normal states, but `WON` is reserved for confirmed received revenue.

Revenue records:

- use positive integer minor units;
- keep a single currency per opportunity;
- require external references for received/refunded money;
- reject idempotency-key replays whose immutable amount/currency differs.

Recurring service agreements require positive net received revenue before activation. Cancelled/ended service states are terminal.

### n8n role

The inactive `commercial-maintenance.json` workflow calls the Control API every 15 minutes to retrieve due follow-ups, renewals, and approved manual actions. It neither grants approval nor sends external messages.


## V1 platform architecture

The platform layer wraps the existing authorization-gated engineering engine; it does not replace its policy boundaries.

### Workspace boundary

Customer product requests authenticate as a session or API-key principal and resolve workspace membership/scopes before repository access. Targets carry a non-null `workspace_id`, so tenant-scoped queries do not infer tenancy from user-supplied target IDs.

Trusted internal worker/orchestrator tokens remain distinct from customer sessions and API keys.

### Integration boundary

Provider secrets are encrypted in `integration_connections`. The Control API decrypts them only for a currently leased integration delivery or signed webhook verification.

The durable flow is:

```text
product transaction
  -> workspace integration event
  -> integration_outbox
  -> n8n trigger
  -> integration worker lease
  -> provider adapter
  -> success / retry / dead-letter
```

Outbox creation can participate in the same PostgreSQL transaction as the product event, preventing a committed finding/revenue event from silently losing its integration notification.

Generic webhooks are restricted to credential-free HTTPS URLs whose DNS answers resolve to public addresses, and deliveries are HMAC signed. Stripe and GitHub inbound webhook signatures are verified before processing and provider event IDs are replay-deduplicated.

### Release trust boundary

Release certification separates software correctness, security hygiene and recoverability:

- correctness: full PostgreSQL-backed automated suite;
- dependency/secrets: npm audit + repository scan;
- container/filesystem vulnerability gate: Trivy HIGH/CRITICAL;
- performance: deterministic synthetic hot-path benchmark with a minimum floor;
- recoverability: PostgreSQL 17 custom backup restored into a clean database and canonical tables verified;
- deployability: Docker Compose validation plus control/browser production image builds.

A green release gate certifies repository artifacts and deployment definitions. It is not evidence that external DNS, TLS, cloud infrastructure, customer credentials, or third-party provider accounts have been provisioned.
