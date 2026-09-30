import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { escapeHtml, fmtDate, fmtRelative } from "../core/format.js";
import { chip, panel, recoveryBlock, setPageMeta, tablePanel, $, $$, toast } from "../components/ui.js";
import { toggleMonitor } from "../components/actions.js";

export async function renderRuns({ content, signal }) {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/operations?limit=400`, { signal, cacheMs: 4000 });
  if (signal.aborted) return;
  const jobs = data.jobs || [];
  const regressions = data.regressions || [];
  const monitors = data.monitors || [];
  const failing = jobs.filter((item) => ["FAILED", "DEAD_LETTER"].includes(item.state));
  const running = jobs.filter((item) => item.state === "RUNNING");
  const retrying = jobs.filter((item) => item.next_attempt_at && item.state === "QUEUED");

  content.innerHTML = `
    <div class="metrics">
      ${metricLocal("Running", running.length, running[0] ? `heartbeat ${fmtRelative(running[0].last_heartbeat_at)}` : "No active worker leases")}
      ${metricLocal("Retrying", retrying.length, "Bounded exponential retry")}
      ${metricLocal("Failed / dead-letter", failing.length, "Requires inspection")}
      ${metricLocal("Open regressions", regressions.filter((r) => r.status !== "RESOLVED").length, `${monitors.filter((m) => Number(m.consecutive_failures) > 0).length} monitors failing`)}
    </div>

    <div class="toolbar" style="margin-top:10px">
      <div class="filters"><input id="run-search" type="search" placeholder="Search runs…" aria-label="Search runs"><select id="run-state"><option value="">All states</option><option>QUEUED</option><option>RUNNING</option><option>SUCCEEDED</option><option>FAILED</option><option>DEAD_LETTER</option></select></div>
      <span class="muted">Worker output remains private; only safe operational fields appear here.</span>
    </div>

    ${tablePanel({
      title: "Runs",
      headers: ["State","Capability","Target","Worker","Attempt","Duration","Cost","Heartbeat","Created"],
      rows: jobs.map((item) => {
        const duration = item.started_at && item.completed_at ? Math.max(0, Math.round((new Date(item.completed_at)-new Date(item.started_at))/1000)) + "s" : item.started_at ? "running" : "—";
        return [
          `<span class="run-row" data-search="${escapeHtml(`${item.job_type} ${item.capability} ${item.organization_name} ${item.worker_id || ""}`.toLowerCase())}" data-state="${escapeHtml(item.state)}">${chip(item.state)}</span>`,
          `<div class="primary-text">${escapeHtml(item.capability)}</div><div class="secondary-text">${escapeHtml(item.job_type)}</div>`,
          `<a data-link class="row-link" href="/console/targets/${item.target_id}">${escapeHtml(item.organization_name)}</a>`,
          escapeHtml(item.worker_id || "—"),
          `${escapeHtml(item.attempt_count)}/${escapeHtml(item.max_attempts)}`,
          escapeHtml(duration), escapeHtml(item.cost_units),
          escapeHtml(fmtRelative(item.last_heartbeat_at)), escapeHtml(fmtDate(item.created_at)),
        ];
      }),
      emptyTitle: "No runs",
      emptyCopy: "Authorized assessment, monitoring, verification, and repair work will appear here.",
      subtitle: "One operational view for queue, execution, retry, success, and dead-letter states.",
    })}

    ${failing.length ? `<div style="margin-top:10px">${panel("Failure recovery", `<div class="panel-body stack">${failing.slice(0,5).map((item) => recoveryBlock({ message: `${item.job_type} is ${item.state}`, code: item.state }, {
      impact: `The ${item.capability} job for ${item.organization_name} did not complete successfully.`,
      next: "Open the target to confirm authorization, inspect related proof, then allow the bounded retry/requeue path rather than replaying mutations.",
    })).join("")}</div>`, { badge: String(failing.length) })}</div>` : ""}

    <div class="split equal-split">
      ${tablePanel({
        title: "Regressions",
        headers: ["Severity","Signal","Target","Status","Opened","Resolved"],
        rows: regressions.map((item) => [chip(item.severity), escapeHtml(item.summary), `<a data-link href="/console/targets/${item.target_id}">${escapeHtml(item.organization_name)}</a>`, chip(item.status), escapeHtml(fmtDate(item.created_at)), escapeHtml(fmtDate(item.resolved_at))]),
        emptyTitle: "No regressions", emptyCopy: "Continuous monitoring is not reporting regressions.",
      })}
      ${tablePanel({
        title: "Monitors",
        headers: ["Monitor","Target","State","Cadence","Failures","Last","Action"],
        rows: monitors.map((item) => [`<div class="primary-text">${escapeHtml(item.name)}</div><div class="secondary-text">${escapeHtml(item.capability)}</div>`, `<a data-link href="/console/targets/${item.target_id}">${escapeHtml(item.organization_name)}</a>`, chip(item.enabled ? "ACTIVE" : "DISABLED"), `${escapeHtml(item.cadence_minutes)}m`, escapeHtml(item.consecutive_failures), escapeHtml(fmtRelative(item.last_run_at)), `<button class="button small run-monitor-toggle" data-id="${item.id}" data-enabled="${item.enabled ? "1" : "0"}" type="button">${item.enabled ? "Disable" : "Enable"}</button>`]),
        emptyTitle: "No monitors", emptyCopy: "Create a target monitor to establish a continuous baseline.",
      })}
    </div>`;
  setPageMeta(`${jobs.length} recent jobs · ${failing.length} need attention`);

  const apply = () => {
    const query = $("#run-search").value.trim().toLowerCase();
    const selected = $("#run-state").value;
    $$(".run-row").forEach((marker) => {
      marker.closest("tr").hidden = (query && !marker.dataset.search.includes(query)) || (selected && marker.dataset.state !== selected);
    });
  };
  $("#run-search").addEventListener("input", apply);
  $("#run-state").addEventListener("change", apply);
  $$(".run-monitor-toggle").forEach((button) => button.addEventListener("click", () => {
    const monitor = monitors.find((item) => item.id === button.dataset.id);
    toggleMonitor(monitor, button.dataset.enabled !== "1").catch((error) => toast(error.message, true));
  }));
}

function metricLocal(label, value, meta) {
  return `<article class="metric"><span class="metric-label">${escapeHtml(label)}</span><div class="metric-value">${escapeHtml(value)}</div><div class="metric-meta">${escapeHtml(meta)}</div></article>`;
}
