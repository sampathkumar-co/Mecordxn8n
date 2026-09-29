# Mecord × n8n

Mecord × n8n is an authorization-gated automation and remediation platform that turns public website-quality observations into verified engineering work.

## Core split

- **n8n** — durable orchestration: triggers, queues, retries, schedules, webhooks, and integrations.
- **Control API** — authorization, target scope, job state, leases, findings, and audit history.
- **Workers / Mecord Connect / MCP** — authorized execution: observe, reproduce, diagnose, patch, test, verify.
- **ChatGPT** — architecture, reasoning, debugging, implementation decisions, and review.

## Safety boundary

Every target is assigned an authorization mode:

- `PUBLIC_QA_ONLY` — benign public-site quality checks only.
- `BUG_BOUNTY` — testing limited to the explicit program scope and rules.
- `CLIENT_AUTHORIZED` — testing limited to the written client scope.
- `DO_NOT_TEST` — no automated testing.

Security-capable workflows fail closed unless an active authorization record explicitly permits the requested capability.

## Implemented modules

### Foundation

- target + authorization registry,
- exact-host and expiry enforcement,
- durable PostgreSQL job state,
- lease ownership and retry-safe worker dispatch,
- deduplicated findings,
- immutable audit events,
- n8n job intake and worker dispatch workflows.

### Public HTTP observer

A read-only worker for `PUBLIC_HTTP_OBSERVE` jobs. It performs one bounded GET observation, rejects private/reserved destinations and non-standard ports, and stores HTTP failures as findings.

### Browser QA

A non-interactive Playwright worker for `BROWSER_QA` jobs.

It:

- leases only already-authorized jobs,
- uses GET/HEAD/OPTIONS only,
- does not click, type, submit forms, or accept downloads,
- blocks out-of-scope top-level navigation before it occurs,
- sends browser traffic through a public-only egress proxy,
- rejects private, link-local, reserved and non-web-port destinations,
- blocks service workers,
- records console errors, page runtime errors, same-site HTTP failures and request failures,
- detects broken rendered images and horizontal overflow,
- stores bounded viewport screenshots with SHA-256 hashes,
- records navigation and basic rendering/performance evidence.

Browser artifacts are written to the shared `artifacts_data` volume and mounted read-only into n8n for later evidence/report workflows.

## Development

```bash
cp .env.example .env
docker compose up --build
```

The n8n workflow JSON files under `n8n/workflows/` are intentionally inactive on import. Review credentials, environment variables, target scope, and workflow behavior before activating them.

## Next major module

Independent finding verification: rerun a finding from a fresh worker/session, compare evidence, reject non-reproducible noise, and only then allow an authorized Mecord remediation handoff.
