import { escapeHtml } from "../components/evidence.js";

function valueOf(result) {
  return result.status === "fulfilled" ? result.value : null;
}

function metric(label, value, meta = "") {
  return '<div class="metric home-metric"><div class="eyebrow">' + escapeHtml(label) + '</div><div class="value">' +
    escapeHtml(value ?? "—") + '</div><div class="meta"><span>' + escapeHtml(meta) + '</span></div></div>';
}

function action(kind, title, meta, route, priority = 50) {
  return { kind, title, meta, route, priority };
}

function sourceState(result, label) {
  if (result.status === "fulfilled") return "";
  return '<div class="section-degraded"><strong>' + escapeHtml(label) + ' unavailable</strong><span>Other workspace data is still shown. Refresh to retry this section.</span></div>';
}

export async function renderHomeView({
  container,
  api,
  workspaceId,
  fmtDate,
  fmtMoney,
  navigate,
}) {
  const results = await Promise.allSettled([
    api('/v1/platform/workspaces/' + workspaceId + '/overview'),
    api('/v1/platform/workspaces/' + workspaceId + '/approvals?status=PENDING&limit=12'),
    api('/v1/platform/workspaces/' + workspaceId + '/findings?limit=40'),
    api('/v1/platform/workspaces/' + workspaceId + '/operations?limit=40'),
  ]);

  if (results.every((item) => item.status === "rejected")) {
    throw results[0].reason;
  }

  const overview = valueOf(results[0]);
  const approvals = valueOf(results[1])?.approvals || [];
  const findings = valueOf(results[2])?.findings || [];
  const operations = valueOf(results[3]) || { jobs: [], regressions: [], monitors: [] };

  const actions = [];

  for (const item of approvals.filter((row) => row.status === "PENDING")) {
    actions.push(action(
      "Approval",
      (item.action_type || "Approval") + " · " + (item.organization_name || "Target"),
      "Requested by " + (item.requested_by || "unknown") + " · expires " + fmtDate(item.expires_at),
      "/console/approvals",
      10,
    ));
  }

  for (const item of findings.filter((row) =>
    row.severity === "HIGH" &&
    row.verificationState === "VERIFIED" &&
    row.status !== "RESOLVED"
  ).slice(0, 8)) {
    actions.push(action(
      "Verified finding",
      item.title,
      (item.organizationName || "Target") + " · " + (item.category || "engineering signal"),
      "/console/findings/" + item.id,
      20,
    ));
  }

  for (const item of (operations.regressions || []).filter((row) => row.status === "OPEN").slice(0, 6)) {
    actions.push(action(
      "Regression",
      item.summary || item.category || "Open regression",
      (item.organization_name || "Target") + " · " + (item.severity || "UNKNOWN"),
      "/console/runs",
      item.severity === "HIGH" ? 15 : 30,
    ));
  }

  for (const item of (operations.jobs || []).filter((row) =>
    ["FAILED", "DEAD_LETTER"].includes(row.state)
  ).slice(0, 6)) {
    actions.push(action(
      "Runtime",
      (item.job_type || item.capability || "Job") + " failed",
      (item.organization_name || "Target") + " · attempts " + (item.attempt_count ?? 0) + "/" + (item.max_attempts ?? "—"),
      "/console/runs",
      item.state === "DEAD_LETTER" ? 5 : 25,
    ));
  }

  for (const item of (operations.monitors || []).filter((row) => Number(row.consecutive_failures || 0) > 0).slice(0, 5)) {
    actions.push(action(
      "Monitor",
      (item.name || "Monitor") + " is degraded",
      (item.organization_name || "Target") + " · " + item.consecutive_failures + " consecutive failures",
      "/console/runs",
      18,
    ));
  }

  actions.sort((a, b) => a.priority - b.priority);
  const visibleActions = actions.slice(0, 12);

  const revenue = Object.entries(overview?.revenueByCurrency || {})
    .map(([currency, row]) => fmtMoney(row.netReceivedMinor, currency))
    .join(" · ") || "No received revenue yet";
  const pipelineCount = Object.values(overview?.pipeline || {})
    .reduce((sum, count) => sum + Number(count || 0), 0);

  container.innerHTML = `
    ${results.some((item) => item.status === "rejected")
      ? '<div class="partial-banner"><strong>Partial workspace data</strong><span>One or more secondary data sources could not be loaded. Available data remains usable.</span></div>'
      : ''}

    <div class="grid metrics home-metrics">
      ${metric("Verified findings", overview?.findings?.verified ?? "—", (overview?.findings?.high_open || 0) + " high open")}
      ${metric("Approvals waiting", overview?.pendingApprovals ?? approvals.length, "Human decision queue")}
      ${metric("Open regressions", overview?.openRegressions ?? "—", "Continuous monitoring")}
      ${metric("Runtime failures", overview?.jobs?.dead_letter ?? "—", "Dead-letter jobs")}
    </div>

    <div class="home-grid">
      <section class="panel action-queue">
        <div class="panel-header split">
          <div><p class="eyebrow">NEXT ACTIONS</p><h2>Action queue</h2></div>
          <span class="chip ${visibleActions.length ? "neutral" : "good"}">${visibleActions.length}</span>
        </div>
        ${sourceState(results[1], "Approvals")}
        ${sourceState(results[2], "Findings")}
        ${sourceState(results[3], "Operations")}
        <div class="action-list">
          ${visibleActions.length ? visibleActions.map((item, index) => `
            <button class="action-row" type="button" data-action-route="${escapeHtml(item.route)}" data-action-index="${index}">
              <span class="action-kind">${escapeHtml(item.kind)}</span>
              <span class="action-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta)}</small></span>
              <span aria-hidden="true">→</span>
            </button>
          `).join("") : '<div class="empty"><strong>No urgent action</strong>Your verified findings, approvals, regressions, and runtime failures are clear right now.</div>'}
        </div>
      </section>

      <aside class="home-side">
        <section class="panel compact-panel">
          <div class="panel-header"><h3>Operating pulse</h3><span class="chip ${overview?.jobs?.dead_letter ? "danger" : "good"}">${overview?.jobs?.dead_letter || 0} dead-letter</span></div>
          <div class="finding-stats">
            <div class="finding-stat"><span>Jobs · 24h</span><strong>${escapeHtml(overview?.jobs?.last_24h ?? "—")}</strong></div>
            <div class="finding-stat"><span>Running now</span><strong>${escapeHtml(overview?.jobs?.running ?? "—")}</strong></div>
            <div class="finding-stat"><span>Opportunities</span><strong>${escapeHtml(pipelineCount)}</strong></div>
            <div class="finding-stat"><span>Active services</span><strong>${escapeHtml(overview?.services?.active ?? "—")}</strong></div>
            <div class="finding-stat"><span>Renewals ≤ 7d</span><strong>${escapeHtml(overview?.services?.renewals_due ?? "—")}</strong></div>
            <div class="finding-stat"><span>Security events · 24h</span><strong>${escapeHtml(overview?.securityEvents24h ?? "—")}</strong></div>
          </div>
        </section>

        <section class="panel compact-panel">
          <div class="panel-header"><h3>Workspace</h3><span class="chip good">${escapeHtml(overview?.workspace?.plan || "—")}</span></div>
          <div class="finding-stats">
            <div class="finding-stat"><span>Subscription</span><strong>${escapeHtml(overview?.workspace?.subscriptionStatus || "—")}</strong></div>
            <div class="finding-stat"><span>Retention</span><strong>${escapeHtml(overview?.workspace?.retentionDays ? overview.workspace.retentionDays + " days" : "—")}</strong></div>
            <div class="finding-stat"><span>Recorded revenue</span><strong>${escapeHtml(revenue)}</strong></div>
          </div>
        </section>
      </aside>
    </div>
  `;

  container.querySelectorAll("[data-action-route]").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.actionRoute));
  });
}
