# Architecture

## Trust boundary

The system is deliberately split into three layers:

1. **n8n** owns orchestration, retries, schedules, fan-out, and integrations.
2. **Control API** owns authorization and durable job state.
3. **Mecord Connect / MCP workers** execute only jobs that have already been authorized.

No scanner or remediation worker should accept a raw target URL directly from an external caller.

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

## Initial job lifecycle

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
       future worker
```

The next build slice adds lease-based workers, findings/evidence storage, and the first benign browser-QA worker.
