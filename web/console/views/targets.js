import { api, settleRequests } from "../core/api.js";
import { state } from "../core/state.js";
import { permission, disabledAttrs } from "../core/permissions.js";
import { escapeHtml, fmtDate, fmtRelative, hostname, remaining } from "../core/format.js";
import { chip, detail, entityHeader, panel, partialBanner, setPageMeta, tablePanel, tabs, $, $$, emptyState, toast } from "../components/ui.js";
import { openAuthorizationCenter, openMonitorForm, runAssessment, toggleMonitor, createReport } from "../components/actions.js";

export async function renderTargets({ content, signal }) {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/targets?limit=200`, { signal, cacheMs: 7000 });
  if (signal.aborted) return;
  const targets = data.targets || [];
  const addAccess = permission("OPERATOR", { operational: true });

  content.innerHTML = `
    <div class="toolbar">
      <div class="filters">
        <input id="target-search" type="search" placeholder="Search targets…" aria-label="Search targets">
        <select id="target-auth-filter" aria-label="Filter authorization"><option value="">All authorization</option><option>PUBLIC_QA_ONLY</option><option>BUG_BOUNTY</option><option>CLIENT_AUTHORIZED</option><option>DO_NOT_TEST</option></select>
      </div>
      <button id="targets-add" class="button primary small" type="button" ${disabledAttrs(addAccess)}>Add target</button>
    </div>
    ${tablePanel({
      title: "Authorized targets",
      headers: ["Organization", "Authorization", "Proof", "Monitoring", "Expiry", "Created"],
      rows: targets.map((item) => [
        `<a class="row-link" data-link href="/console/targets/${item.id}" data-target-row data-search="${escapeHtml(`${item.organizationName} ${item.baseUrl}`.toLowerCase())}" data-auth="${escapeHtml(item.authorizationMode || "")}"><span class="primary-text">${escapeHtml(item.organizationName)}</span><div class="secondary-text">${escapeHtml(hostname(item.baseUrl))} · ${escapeHtml(item.baseUrl)}</div></a>`,
        chip(item.authorizationMode || "NONE"),
        `<strong>${escapeHtml(item.findingCount)}</strong> findings`,
        `<strong>${escapeHtml(item.monitorCount)}</strong> active`,
        `<span title="${escapeHtml(fmtDate(item.authorizationExpiresAt))}">${escapeHtml(remaining(item.authorizationExpiresAt))}</span>`,
        escapeHtml(fmtDate(item.createdAt)),
      ]),
      emptyTitle: "No targets yet",
      emptyCopy: "Register the first authorized website or service boundary.",
      subtitle: "Every target is scoped by explicit host, capability, and authorization state.",
    })}
  `;
  setPageMeta(`${targets.length} targets`);
  $("#targets-add")?.addEventListener("click", () => document.dispatchEvent(new CustomEvent("mecord:create-target")));

  const apply = () => {
    const query = $("#target-search").value.trim().toLowerCase();
    const auth = $("#target-auth-filter").value;
    $$("[data-target-row]").forEach((link) => {
      const row = link.closest("tr");
      const show = (!query || link.dataset.search.includes(query)) && (!auth || link.dataset.auth === auth);
      row.hidden = !show;
    });
  };
  $("#target-search").addEventListener("input", apply);
  $("#target-auth-filter").addEventListener("change", apply);
}

export async function renderTargetDetail({ content, signal, route }) {
  const id = route.params.id;
  const wid = state.workspaceId;
  const { data, errors } = await settleRequests({
    targets: api(`/v1/platform/workspaces/${wid}/targets?limit=200`, { signal, cacheMs: 7000 }),
    center: api(`/v1/platform/workspaces/${wid}/targets/${id}/authorization-center`, { signal, cacheMs: 4000 }),
    findings: api(`/v1/platform/workspaces/${wid}/findings?limit=300`, { signal, cacheMs: 5000 }),
    operations: api(`/v1/platform/workspaces/${wid}/operations?limit=300`, { signal, cacheMs: 5000 }),
    approvals: api(`/v1/platform/workspaces/${wid}/approvals?limit=200`, { signal, cacheMs: 5000 }),
  });
  if (signal.aborted) return;
  const target = (data.targets?.targets || []).find((item) => item.id === id);
  if (!target) throw Object.assign(new Error("Target not found in this workspace."), { status: 404 });

  const center = data.center || {};
  const current = center.currentAuthorization || {};
  const verified = (center.domainVerifications || []).some((item) => item.status === "VERIFIED");
  const findings = (data.findings?.findings || []).filter((item) => item.targetId === id);
  const jobs = (data.operations?.jobs || []).filter((item) => item.target_id === id);
  const monitors = (data.operations?.monitors || []).filter((item) => item.target_id === id);
  const regressions = (data.operations?.regressions || []).filter((item) => item.target_id === id);
  const approvals = (data.approvals?.approvals || []).filter((item) => item.target_id === id);
  const sourceCap = (current.allowed_capabilities || current.allowedCapabilities || []).includes("SOURCE_REMEDIATION");
  const opsAccess = permission("OPERATOR", { operational: true });
  const adminAccess = permission("ADMIN", { operational: true });

  content.innerHTML = `
    ${partialBanner(errors)}
    ${entityHeader({
      eyebrow: "TARGET",
      title: target.organizationName,
      subtitle: target.baseUrl,
      badges: [target.authorizationMode || "NO AUTHORIZATION", verified ? "OWNERSHIP VERIFIED" : "OWNERSHIP NOT VERIFIED", sourceCap ? "SOURCE REPAIR ENABLED" : "SOURCE REPAIR OFF"],
      actions: `<button id="target-assess" class="button primary small" type="button" ${disabledAttrs(opsAccess)}>Run assessment</button><button id="target-monitor" class="button small" type="button" ${disabledAttrs(opsAccess)}>Add monitor</button><button id="target-auth" class="button small" type="button" ${disabledAttrs(adminAccess)}>Authorization</button>`,
    })}
    ${tabs([
      { id: "overview", label: "Overview" },
      { id: "findings", label: "Findings", count: findings.length },
      { id: "runs", label: "Runs", count: jobs.length },
      { id: "monitoring", label: "Monitoring", count: monitors.length },
      { id: "authorization", label: "Authorization" },
      { id: "reports", label: "Reports" },
      { id: "activity", label: "Activity" },
    ], "overview")}
    <div id="target-tab-content" style="margin-top:10px"></div>`;

  const renderTab = (name) => {
    $$(".tab").forEach((node) => {
      const active = node.dataset.tab === name;
      node.classList.toggle("active", active);
      node.setAttribute("aria-selected", active ? "true" : "false");
    });
    const slot = $("#target-tab-content");
    const views = {
      overview: `
        <div class="metrics">
          ${metricLocal("Verified findings", findings.filter((f) => f.verificationState === "VERIFIED").length, `${findings.filter((f) => f.severity === "HIGH").length} high severity`)}
          ${metricLocal("Active monitors", monitors.filter((m) => m.enabled).length, `${monitors.filter((m) => Number(m.consecutive_failures) > 0).length} failing`)}
          ${metricLocal("Open regressions", regressions.filter((r) => r.status !== "RESOLVED").length, "Continuous QA signals")}
          ${metricLocal("Pending approvals", approvals.filter((a) => a.status === "PENDING").length, "Human decision gates")}
        </div>
        <div class="split">
          ${panel("Trust boundary", `<div class="panel-body detail-grid">
            ${detail("Authorization", target.authorizationMode || "NONE")}${detail("Ownership", verified ? "VERIFIED" : "NOT VERIFIED")}
            ${detail("Exact hosts", (current.allowed_hosts || current.allowedHosts || []).join(", ") || hostname(target.baseUrl))}
            ${detail("Expiry", current.expires_at ? `${fmtDate(current.expires_at)} · ${remaining(current.expires_at)}` : "No expiry")}
            ${detail("Source remediation", sourceCap ? "EXPLICITLY GRANTED" : "NOT GRANTED")}${detail("Evidence reference", current.evidence_reference || current.evidenceReference || "—")}
          </div>`)}
          ${panel("Recent run", jobs[0] ? `<div class="panel-body detail-grid">${detail("State", jobs[0].state)}${detail("Capability", jobs[0].capability)}${detail("Attempts", `${jobs[0].attempt_count}/${jobs[0].max_attempts}`)}${detail("Created", fmtDate(jobs[0].created_at))}</div>` : emptyState("No runs yet", "Run the first authorized assessment to generate evidence."))}
        </div>`,
      findings: tablePanel({
        title: "Target findings", headers: ["Severity","Finding","Verification","Occurrences","Last seen"],
        rows: findings.map((f) => [chip(f.severity), `<a data-link href="/console/findings/${f.id}" class="row-link"><span class="primary-text">${escapeHtml(f.title)}</span><div class="secondary-text">${escapeHtml(f.category)} · ${escapeHtml(f.affectedUrl)}</div></a>`, chip(f.verificationState), escapeHtml(f.occurrences), escapeHtml(fmtDate(f.lastSeenAt))]),
        emptyTitle: "No findings", emptyCopy: "Authorized QA has not produced findings for this target.",
      }),
      runs: tablePanel({
        title: "Target runs", headers: ["State","Job","Capability","Attempts","Cost","Created"],
        rows: jobs.map((j) => [chip(j.state), escapeHtml(j.job_type), escapeHtml(j.capability), `${j.attempt_count}/${j.max_attempts}`, escapeHtml(j.cost_units), escapeHtml(fmtDate(j.created_at))]),
        emptyTitle: "No runs", emptyCopy: "Assessment and monitoring jobs will appear here.",
      }),
      monitoring: `${tablePanel({
        title: "Continuous monitors", headers: ["Monitor","Capability","State","Cadence","Failures","Next","Action"],
        rows: monitors.map((m) => [`<span class="primary-text">${escapeHtml(m.name)}</span>`, escapeHtml(m.capability), chip(m.enabled ? "ACTIVE" : "DISABLED"), `${escapeHtml(m.cadence_minutes)}m`, escapeHtml(m.consecutive_failures), escapeHtml(fmtRelative(m.next_run_at)), `<button class="button small monitor-toggle" data-id="${m.id}" data-enabled="${m.enabled ? "1" : "0"}" type="button">${m.enabled ? "Disable" : "Enable"}</button>`]),
        emptyTitle: "No monitors", emptyCopy: "Create a bounded HTTP or browser monitor.",
      })}${regressions.length ? tablePanel({
        title: "Regression history", headers: ["Severity","Signal","Status","Opened","Resolved"],
        rows: regressions.map((r) => [chip(r.severity), escapeHtml(r.summary), chip(r.status), escapeHtml(fmtDate(r.created_at)), escapeHtml(fmtDate(r.resolved_at))]),
      }) : ""}`,
      authorization: `
        <div class="split">
          ${panel("Current authorization", `<div class="panel-body detail-grid">${detail("Mode", current.mode || "NONE")}${detail("Ownership", verified ? "VERIFIED" : "NOT VERIFIED")}${detail("Allowed hosts", (current.allowed_hosts || current.allowedHosts || []).join(", ") || "—")}${detail("Capabilities", (current.allowed_capabilities || current.allowedCapabilities || []).join(", ") || "—")}${detail("Expires", current.expires_at ? fmtDate(current.expires_at) : "No expiry")}${detail("Evidence", current.evidence_reference || "—")}</div>`, { actions: '<button id="auth-tab-open" class="button small">Manage</button>' })}
          ${panel("History", `<div class="panel-body timeline">${(center.authorizationHistory || []).slice(0,16).map((h) => `<div class="timeline-item"><strong>${escapeHtml(h.mode || "Authorization")}</strong><p>${escapeHtml(fmtDate(h.created_at || h.createdAt))} · ${h.revoked_at ? "revoked" : "recorded"}</p></div>`).join("") || '<span class="muted">No history.</span>'}</div>`)}
        </div>`,
      reports: panel("Reports & release gates", `<div class="panel-body">
        <p class="muted">Generated client reports remain READY until an explicit report-release approval. Approved reports can receive expiring secure share links.</p>
        <div class="filters"><button id="target-generate-report" class="button small primary" type="button" ${disabledAttrs(opsAccess)}>Generate report</button><a class="button small" data-link href="/console/approvals">Open report approvals</a></div>
        ${approvals.filter((a) => a.report_id).length ? `<div style="margin-top:12px">${approvals.filter((a) => a.report_id).map((a) => `<div class="action-item"><span class="action-rank">R</span><div><strong>${escapeHtml(a.action_type)}</strong><p>${escapeHtml(fmtDate(a.created_at))}</p></div>${chip(a.status)}</div>`).join("")}</div>` : ""}
      </div>`),
      activity: panel("Target activity", `<div class="panel-body timeline">${[
        ...jobs.slice(0,8).map((j) => ({ label: `${j.job_type} · ${j.state}`, at: j.created_at })),
        ...approvals.slice(0,8).map((a) => ({ label: `${a.action_type} · ${a.status}`, at: a.created_at })),
      ].sort((a,b)=>new Date(b.at)-new Date(a.at)).slice(0,14).map((item) => `<div class="timeline-item"><strong>${escapeHtml(item.label)}</strong><p>${escapeHtml(fmtDate(item.at))}</p></div>`).join("") || '<span class="muted">No activity yet.</span>'}</div>`),
    };
    slot.innerHTML = views[name] || views.overview;

    $("#auth-tab-open")?.addEventListener("click", () => openAuthorizationCenter(id));
    $("#target-generate-report")?.addEventListener("click", () => createReport(id).catch((e) => toast(e.message, true)));
    $$(".monitor-toggle").forEach((button) => {
      button.addEventListener("click", () => {
        const monitor = monitors.find((m) => m.id === button.dataset.id);
        toggleMonitor(monitor, button.dataset.enabled !== "1").catch((e) => toast(e.message, true));
      });
    });
  };

  $$(".tab").forEach((button) => button.addEventListener("click", () => renderTab(button.dataset.tab)));
  $("#target-assess").addEventListener("click", () => runAssessment(id).catch((e) => toast(e.message, true)));
  $("#target-monitor").addEventListener("click", () => openMonitorForm(target));
  $("#target-auth").addEventListener("click", () => openAuthorizationCenter(id));
  renderTab("overview");
  setPageMeta(`${hostname(target.baseUrl)} · ${remaining(target.authorizationExpiresAt)}`);
}

function metricLocal(label, value, meta) {
  return `<article class="metric"><span class="metric-label">${escapeHtml(label)}</span><div class="metric-value">${escapeHtml(value)}</div><div class="metric-meta">${escapeHtml(meta)}</div></article>`;
}
