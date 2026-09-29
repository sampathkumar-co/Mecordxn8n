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
