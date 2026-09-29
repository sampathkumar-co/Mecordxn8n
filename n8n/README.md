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
