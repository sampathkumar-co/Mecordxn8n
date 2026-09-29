# n8n workflows

The workflows in this directory are orchestration adapters. They do **not** decide whether a requested capability is authorized.

The control API is the policy enforcement point. Every worker or parent workflow must obtain a job through the control API before performing target work.

## Job intake

Import `workflows/job-intake.json` into n8n.

It expects:

- `MECORDXN8N_CONTROL_API_URL`
- `MECORDXN8N_ORCHESTRATOR_TOKEN`

The workflow intentionally uses **Execute Workflow Trigger**, not a public webhook. A future MCP/webhook ingress workflow should authenticate the caller and then invoke this sub-workflow.

Example browser-QA job input:

```json
{
  "targetId": "uuid",
  "jobType": "browser-qa",
  "capability": "BROWSER_QA",
  "requestedUrl": "https://example.com/checkout",
  "input": {
    "viewport": "mobile"
  }
}
```

A successful response contains a queued job that workers can lease only after the control API has approved its scope.

## Public HTTP dispatch

Import `workflows/public-http-dispatch.json`. It triggers one authorized `PUBLIC_HTTP_OBSERVE` lease attempt per schedule tick.

## Browser QA dispatch

Import `workflows/browser-qa-dispatch.json`.

It expects:

- `MECORDXN8N_BROWSER_QA_URL`
- `MECORDXN8N_WORKER_TRIGGER_TOKEN`

The dispatcher does not receive arbitrary target URLs. It only asks the browser worker to lease the next already-authorized `BROWSER_QA` job.

The browser worker is deliberately passive:

- no clicks,
- no form submissions,
- no authenticated actions,
- no POST/PUT/PATCH/DELETE requests,
- no non-standard ports,
- no private/reserved IP destinations.

It records initial page/runtime/console/network failures and stores them as deduplicated findings through the control API.


## Production maintenance

Import `workflows/production-maintenance.json`.

Every five minutes it calls the authenticated control API maintenance tick. The control API—not n8n—atomically claims due policies, re-checks authorization, applies daily budgets, cancels invalid queued work, and sweeps exhausted jobs.

n8n never decides whether a target is allowed to run and never approves remediation.

## Human approval

There is intentionally no workflow that auto-approves source remediation or report release. Approval remains an explicit control-API/user action so retries, schedules, or an AI workflow cannot silently grant authority.

## Commercial maintenance

Import `workflows/commercial-maintenance.json` only after reviewing the commercial policy and environment.

It runs every 15 minutes and calls the authenticated `POST /v1/commercial/maintenance` Control API endpoint. The response is an internal worklist containing:

- opportunities whose next action is due,
- active services with renewals due within seven days,
- outbound actions that already passed human approval and still require manual/provider handling.

The workflow is inactive on import.

It deliberately does **not**:

- discover or scrape personal contact data,
- grant contact consent,
- approve outbound actions,
- send email, WhatsApp, SMS, or phone messages,
- bypass cooldowns or activation caps.

Any future delivery-provider workflow must consume only Control-API-approved action IDs and must record its result back through the commercial delivery endpoint. Policy remains in PostgreSQL/Control API, not n8n.
