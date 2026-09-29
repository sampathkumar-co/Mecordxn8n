# Mecord × n8n

Mecord × n8n is an automation and remediation platform that turns authorized website-quality findings into verified engineering work.

## Core split

- **n8n** — durable orchestration: triggers, queues, retries, schedules, webhooks, and integrations.
- **Mecord Connect / MCP** — authorized engineering execution: inspect, reproduce, patch, test, verify.
- **ChatGPT** — architecture, reasoning, debugging, implementation decisions, and review.

## Safety boundary

Every target is assigned an authorization mode:

- `PUBLIC_QA_ONLY` — benign public-site quality checks only.
- `BUG_BOUNTY` — testing limited to the explicit program scope and rules.
- `CLIENT_AUTHORIZED` — testing limited to the written client scope.
- `DO_NOT_TEST` — no automated testing.

Security-capable workflows must fail closed unless an active authorization record permits the requested capability.

## Initial milestone

The first vertical slice implements:

1. target and authorization registry,
2. audit job lifecycle,
3. n8n-facing control API,
4. PostgreSQL persistence,
5. immutable audit events,
6. automated tests and CI.

Scanner workers, evidence capture, finding verification, and Mecord remediation are layered on top of this foundation.
