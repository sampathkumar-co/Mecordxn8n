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
safe GET observation          passive Chromium load
      |                       no clicks / mutations
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

The browser worker is intentionally observation-only. It blocks non-read request methods, private/reserved destinations, non-standard ports, and cross-host top-level redirects. It captures bounded console errors, page runtime exceptions, same-site HTTP failures, and same-site request failures.

A later module will add richer evidence artifacts and independent finding verification before any Mecord remediation handoff.
