# Mecord × n8n

Mecord × n8n is an authorization-gated **Problem → Proof → Repair → Revenue** orchestration system for website quality engineering.

## Runtime split

- **n8n** — schedules, retries, durable orchestration, and integration workflows.
- **Control API + PostgreSQL** — authorization, targets, jobs, leases, findings, verification, evidence, opportunity intelligence, remediation state, reports, and audit history.
- **Browser/HTTP workers** — bounded public QA execution.
- **Mecord Connect MCP** — client-authorized source remediation.
- **ChatGPT** — architecture, debugging, implementation decisions, review, and further engineering.

## Milestone A — revenue-capable MVP

Milestone A is implemented on `build/milestone-a`.

### 1. Authorization and target registry

Every target is one of:

- `PUBLIC_QA_ONLY`
- `BUG_BOUNTY`
- `CLIENT_AUTHORIZED`
- `DO_NOT_TEST`

Capabilities, exact hosts, and expiry are enforced in code. `SOURCE_REMEDIATION` requires `CLIENT_AUTHORIZED`.

### 2. Site intake and discovery

`SITE_DISCOVERY` performs a non-interactive browser load and records a bounded same-origin page inventory. It does not crawl arbitrary external domains.

### 3. Public QA

Implemented workers include:

- `PUBLIC_HTTP_OBSERVE`
- `BROWSER_QA`
- `SITE_DISCOVERY`
- `JOURNEY_QA`

Browser execution blocks mutation methods, private/reserved destinations, non-web ports, service workers, downloads, popups, and out-of-scope top-level navigation. Screenshots and bounded runtime/network/rendering evidence are stored for later verification/reporting.

### 4. Read-only journey QA

A journey is a bounded sequence of same-origin page loads with status/title assertions. Public QA journeys intentionally do not click, type, authenticate, or submit forms.

### 5. Finding intelligence

Findings are fingerprinted and deduplicated. Runtime-error fingerprints cluster identical error signatures across pages on the same host. Verified findings receive deterministic:

- business-impact score,
- buyer relevance,
- repair feasibility,
- engineering effort,
- opportunity score,
- impact tier,
- affected journey classification.

Scores are explicitly directional and do not claim access to private revenue or conversion data.

### 6. Independent verification + evidence

`FINDING_VERIFY` reruns a finding from fresh executions. The default gate requires two matching reproductions. Verification persists:

- attempts and matches,
- confidence,
- evidence snapshots,
- screenshot artifact metadata and SHA-256,
- final `VERIFIED` or `NOT_REPRODUCED` state.

Only verified findings enter the opportunity/report/remediation funnel.

### 7. Mecord MCP remediation bridge

Verified findings may be queued for `SOURCE_REMEDIATION` only when the target is explicitly client-authorized for that capability.

The remediation worker uses the configured Streamable HTTP MCP endpoint:

- `MECORD_MCP_URL`
- `MECORD_MCP_TOKEN`
- `MECORD_MCP_REMEDIATION_TOOL` (default: `operations`)

It initializes an MCP session and submits a bounded remediation outcome containing the verified finding, authorized project root, success conditions, and prohibited scope.

### 8. Opportunity and proposal engine

Verified findings can be retrieved in opportunity-score order. The report API generates a client proposal containing:

- independently reproduced findings,
- affected URLs,
- evidence confidence,
- directional impact assessment,
- opportunity ranking,
- remediation engagement steps,
- authorization/safety scope.

Reports are stored as `READY`; they are **not automatically sent** to third parties.

## n8n workflows

Import the inactive workflow definitions under `n8n/workflows/`:

- job intake,
- public HTTP dispatch,
- browser QA dispatch,
- site discovery dispatch,
- journey QA dispatch,
- finding verification dispatch,
- remediation dispatch.

Review environment variables and target authorization before activation.

## Local stack

```bash
cp .env.example .env
docker compose up --build
```

The MCP remediation worker requires a real authorized Mecord MCP endpoint before remediation jobs can succeed. Public QA, verification, scoring, and proposal generation do not require Mecord credentials.

## Milestone A completion gate

The CI acceptance suite covers:

- database migrations,
- authorization boundaries,
- worker leases,
- finding persistence,
- browser/egress safety,
- MCP transport behavior,
- opportunity scoring,
- verified-finding lifecycle,
- client proposal generation,
- remediation queue authorization,
- n8n workflow JSON validation,
- Docker Compose validation,
- browser worker image build.
