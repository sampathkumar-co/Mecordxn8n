# n8n workflows

The workflows in this directory are orchestration adapters. They do **not** decide whether a requested capability is authorized.

The control API is the policy enforcement point. Every worker or parent workflow must obtain a job through the control API before performing target work.

## Job intake

Import `workflows/job-intake.json` into n8n.

It expects:

- `MECORDXN8N_CONTROL_API_URL`
- `MECORDXN8N_ORCHESTRATOR_TOKEN`

The workflow intentionally uses **Execute Workflow Trigger**, not a public webhook. A future MCP/webhook ingress workflow should authenticate the caller and then invoke this sub-workflow.

Expected input:

```json
{
  "targetId": "uuid",
  "jobType": "browser-qa",
  "capability": "BROWSER_QA",
  "requestedUrl": "https://example.com/checkout",
  "input": {}
}
```

A successful response contains a queued job with the authorization record that approved it.
