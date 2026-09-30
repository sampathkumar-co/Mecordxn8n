import { api, settleRequests } from "../core/api.js";
import { state, currentWorkspace } from "../core/state.js";
import { permission, disabledAttrs } from "../core/permissions.js";
import { escapeHtml, fmtMoney, fmtRelative } from "../core/format.js";
import { chip, metric, panel, partialBanner, setPageMeta, $ } from "../components/ui.js";
import {
  openAuthorizationCenter, openBilling, openBillingPortal, openTargetForm,
  requestReportRelease, runAssessment, shareReport,
} from "../components/actions.js";

function sum(values) {
  return Object.values(values || {}).reduce((total, value) => total + Number(value || 0), 0);
}

function actionItem(rank, title, copy, action, urgent = false) {
  return `<div class="action-item ${urgent ? "urgent" : ""}">
    <span class="action-rank">${rank}</span>
    <div><strong>${escapeHtml(title)}</strong><p>${escapeHtml(copy)}</p></div>
    ${action}
  </div>`;
}

export async function renderHome({ content, signal }) {
  const wid = state.workspaceId;
  const { data, errors } = await settleRequests({
    overview: api(`/v1/platform/workspaces/${wid}/overview`, { signal, cacheMs: 8000 }),
    health: api(`/v1/platform/workspaces/${wid}/health`, { signal, cacheMs: 6000 }),
    onboarding: api(`/v1/platform/workspaces/${wid}/onboarding`, { signal, cacheMs: 6000 }),
    subscription: api(`/v1/platform/workspaces/${wid}/subscription`, { signal, cacheMs: 10000 }),
    approvals: api(`/v1/platform/workspaces/${wid}/approvals?limit=30`, { signal, cacheMs: 5000 }),
    findings: api(`/v1/platform/workspaces/${wid}/findings?limit=60`, { signal, cacheMs: 5000 }),
    operations: api(`/v1/platform/workspaces/${wid}/operations?limit=80`, { signal, cacheMs: 5000 }),
    targets: api(`/v1/platform/workspaces/${wid}/targets?limit=50`, { signal, cacheMs: 8000 }),
  });
  if (signal.aborted) return;
  if (data.subscription) state.subscription = data.subscription;

  const overview = data.overview || {};
  const health = data.health || {};
  const onboarding = data.onboarding || {};
  const approvals = data.approvals?.approvals || [];
  const findings = data.findings?.findings || [];
  const operations = data.operations || { jobs: [], regressions: [], monitors: [] };
  const targets = data.targets?.targets || [];

  const pending = approvals.filter((item) => item.status === "PENDING");
  const verified = findings.filter((item) => item.verificationState === "VERIFIED");
  const highVerified = verified.filter((item) => item.severity === "HIGH");
  const activeRegressions = (operations.regressions || []).filter((item) => item.status !== "RESOLVED");
  const failedJobs = (operations.jobs || []).filter((item) => ["FAILED", "DEAD_LETTER"].includes(item.state));

  const queue = [];
  for (const item of pending.slice(0, 3)) {
    queue.push({
      priority: new Date(item.expires_at).getTime() || Infinity,
      html: actionItem(1, `${item.action_type} needs a decision`, `${item.organization_name} · expires ${fmtRelative(item.expires_at)}`, `<a class="button small primary" data-link href="/console/approvals/${item.id}">Review</a>`, true),
    });
  }
  for (const item of failedJobs.slice(0, 2)) {
    queue.push({
      priority: Date.now() + 1000,
      html: actionItem(2, `${item.job_type} did not complete`, `${item.organization_name} · ${item.state}`, '<a class="button small" data-link href="/console/runs">Inspect run</a>', true),
    });
  }
  for (const item of highVerified.slice(0, 2)) {
    queue.push({
      priority: Date.now() + 2000,
      html: actionItem(3, item.title, `Verified high-severity finding · ${item.organizationName}`, `<a class="button small" data-link href="/console/findings/${item.id}">Open proof</a>`),
    });
  }

  const firstTarget = targets[0] || null;
  const checklist = onboarding.checklist || {};
  const operationsAccess = permission("OPERATOR", { operational: true });
  if (!checklist.targetRegistered) {
    queue.push({
      priority: Date.now() + 5000,
      html: actionItem(
        6,
        "Register the first target",
        operationsAccess.allowed ? "Start with explicitly authorized non-destructive QA." : operationsAccess.reason,
        `<button class="button small primary" id="home-add-target" type="button" ${disabledAttrs(operationsAccess)}>Add target</button>`,
      ),
    });
  } else if (!checklist.assessmentStarted && firstTarget) {
    queue.push({
      priority: Date.now() + 5000,
      html: actionItem(
        6,
        "Run the first assessment",
        operationsAccess.allowed ? "Queues only capabilities already authorized for this target." : operationsAccess.reason,
        `<button class="button small primary" id="home-run-assessment" type="button" ${disabledAttrs(operationsAccess)}>Run assessment</button>`,
      ),
    });
  }

  queue.sort((a, b) => a.priority - b.priority);
  const revenueText = Object.entries(overview.revenueByCurrency || {})
    .map(([currency, row]) => fmtMoney(row.netReceivedMinor, currency)).join(" · ") || "No recorded revenue yet";

  const succeeded = (operations.jobs || []).filter((item) => item.state === "SUCCEEDED").length;
  const running = (operations.jobs || []).filter((item) => item.state === "RUNNING").length;
  const integrationDead = Number(health.integrations24h?.DEAD_LETTER || 0);
  const verificationRate = findings.length ? Math.round((verified.length / findings.length) * 100) : 0;

  const onboardingBody = `<div class="panel-body launch-list">
    ${[
      ["Account created", checklist.accountCreated, "Workspace and owner session are active."],
      ["Target registered", checklist.targetRegistered, firstTarget ? firstTarget.organizationName : "Start with public QA."],
      ["Ownership verified", checklist.ownershipVerified, "Required before self-serve source access."],
      ["Assessment started", checklist.assessmentStarted, "HTTP/browser QA runs inside the authorization boundary."],
      ["Report ready", checklist.reportReady, "External release still needs human approval."],
    ].map(([label, done, copy]) => `<div class="launch-step"><span class="launch-check ${done ? "done" : ""}">${done ? "✓" : "•"}</span><div><strong>${escapeHtml(label)}</strong><div class="secondary-text">${escapeHtml(copy)}</div></div></div>`).join("")}
  </div>`;

  content.innerHTML = `
    ${partialBanner(errors)}
    <div class="metrics">
      ${metric("Verified findings needing action", verified.filter((item) => item.status !== "RESOLVED").length, `${highVerified.length} high severity`)}
      ${metric("Approvals waiting", pending.length, pending[0] ? `Next expires ${fmtRelative(pending[0].expires_at)}` : "No human decisions waiting")}
      ${metric("Active regressions", activeRegressions.length, `${failedJobs.length} failed/dead jobs`)}
      ${metric("Workspace health", health.status || "UNKNOWN", (health.issues || []).join(", ") || "No active health issues", health.status || "UNKNOWN")}
    </div>

    <div class="split">
      ${panel("Action queue", `<div class="action-queue">${queue.length ? queue.slice(0, 7).map((item) => item.html).join("") : '<div class="empty"><strong>Nothing urgent</strong>There are no immediate workspace actions waiting.</div>'}</div>`, { subtitle: "Ordered by decision urgency, runtime failure, severity, and onboarding." })}
      ${panel("Operating pulse", `<div class="panel-body"><div class="pulse-grid">
        <div class="pulse-cell"><strong>${succeeded}</strong><span>Successful runs</span></div>
        <div class="pulse-cell"><strong>${running}</strong><span>Running now</span></div>
        <div class="pulse-cell"><strong>${verificationRate}%</strong><span>Verification rate</span></div>
        <div class="pulse-cell"><strong>${integrationDead}</strong><span>Integration dead-letter</span></div>
      </div></div>`, { badge: failedJobs.length ? "DEGRADED" : "HEALTHY" })}
    </div>

    <div class="split equal-split">
      ${panel("First value", onboardingBody, { badge: onboarding.status || "STARTING", actions: firstTarget ? `<button class="button small" id="home-authorization" type="button">Authorization</button>` : "" })}
      ${panel("Revenue & services", `<div class="panel-body">
        <div class="kpi-strip">
          <div><strong>${escapeHtml(revenueText)}</strong><span>Recorded cash</span></div>
          <div><strong>${sum(overview.pipeline || {})}</strong><span>Open opportunities</span></div>
          <div><strong>${Number(overview.services?.active || 0)}</strong><span>Active services</span></div>
          <div><strong>${Number(overview.services?.renewals_due || 0)}</strong><span>Renewals due ≤ 7d</span></div>
        </div>
        <div class="filters" style="margin-top:14px"><a class="button small" data-link href="/console/revenue">Open revenue</a><button class="button small" id="home-billing-portal" type="button">Billing</button></div>
      </div>`, { subtitle: "Commercial state follows verified engineering work; payment evidence is authoritative." })}
    </div>`;

  setPageMeta(`${currentWorkspace()?.name || "Workspace"} · ${currentWorkspace()?.role || "workspace access"}`);

  $("#home-add-target")?.addEventListener("click", openTargetForm);
  $("#home-run-assessment")?.addEventListener("click", () => runAssessment(firstTarget.id));
  $("#home-authorization")?.addEventListener("click", () => openAuthorizationCenter(firstTarget.id));
  $("#home-billing-portal")?.addEventListener("click", () => openBillingPortal().catch((error) => {
    // Billing can intentionally be unconfigured in a development deployment.
    import("../components/ui.js").then(({ toast }) => toast(error.message, true));
  }));
}
