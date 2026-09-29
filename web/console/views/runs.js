import { escapeHtml } from "../components/evidence.js";

function stateKind(state) {
  if (state === "SUCCEEDED") return "verified";
  if (state === "DEAD_LETTER" || state === "FAILED") return "severity-high";
  if (state === "RUNNING") return "impact";
  if (state === "QUEUED") return "warn";
  return "neutral";
}

function chip(value, kind = "") {
  return '<span class="status-chip ' + escapeHtml(kind || stateKind(value)) + '">' + escapeHtml(value || "UNKNOWN") + '</span>';
}

function summaryCount(jobs, states) {
  return jobs.filter((item) => states.includes(item.state)).length;
}

function recoveryText(job, fmtDate) {
  if (job.state === "QUEUED" && job.next_attempt_at) {
    return "Automatic retry scheduled " + fmtDate(job.next_attempt_at);
  }
  if (job.state === "QUEUED") return "Waiting for an eligible worker lease";
  if (job.state === "RUNNING") {
    return job.last_heartbeat_at
      ? "Heartbeat " + fmtDate(job.last_heartbeat_at)
      : "Execution is active";
  }
  if (job.state === "DEAD_LETTER") return "Retry budget exhausted · inspect before a new run";
  if (job.state === "FAILED") return "Terminal failure · inspect before a new run";
  if (job.state === "CANCELLED") return "Cancelled · inspect authorization and target state";
  if (job.state === "SUCCEEDED") return "Completed successfully";
  return "Inspect run state";
}

export async function renderRunsView({
  container,
  api,
  workspaceId,
  workspace,
  fmtDate,
  navigate,
  toast,
}) {
  const data = await api('/v1/platform/workspaces/' + workspaceId + '/operations?limit=200');
  const jobs = data.jobs || [];
  const regressions = data.regressions || [];
  const monitors = data.monitors || [];
  const canOperate = ["OWNER", "ADMIN", "OPERATOR"].includes(workspace?.role || "");

  container.innerHTML = `
    <section class="queue-summary runs-summary">
      <div>
        <p class="eyebrow">RUNTIME</p>
        <h2>Runs & recovery</h2>
        <p>Execution state, retry scheduling, monitoring health, and guided recovery. No raw worker payloads are exposed here.</p>
      </div>
      <div class="queue-counts">
        <div><strong>${summaryCount(jobs, ["RUNNING","QUEUED"])}</strong><span>Active</span></div>
        <div><strong>${summaryCount(jobs, ["FAILED","DEAD_LETTER"])}</strong><span>Needs attention</span></div>
        <div><strong>${regressions.filter((item) => item.status === "OPEN").length}</strong><span>Regressions</span></div>
      </div>
    </section>

    <section class="panel runs-panel">
      <div class="panel-header split">
        <div><h3>Recent runs</h3><p class="muted">Retries are owned by the control plane. Terminal runs are never blindly replayed from this screen.</p></div>
        <div class="run-filters" role="group" aria-label="Run filters">
          <button class="run-filter active" type="button" data-run-filter="all">All</button>
          <button class="run-filter" type="button" data-run-filter="attention">Needs attention</button>
          <button class="run-filter" type="button" data-run-filter="active">Active</button>
          <button class="run-filter" type="button" data-run-filter="complete">Complete</button>
        </div>
      </div>
      <div id="runs-table"></div>
    </section>

    <div class="runs-secondary">
      <section class="panel">
        <div class="panel-header"><h3>Open regressions</h3><span class="chip ${regressions.some((item)=>item.status==="OPEN") ? "warn" : "good"}">${regressions.filter((item)=>item.status==="OPEN").length}</span></div>
        <div class="compact-list">
          ${regressions.filter((item)=>item.status==="OPEN").slice(0,20).map((item)=>`
            <button class="compact-row" type="button" data-target-id="${escapeHtml(item.target_id)}">
              ${chip(item.severity, item.severity === "HIGH" ? "severity-high" : "warn")}
              <span><strong>${escapeHtml(item.summary)}</strong><small>${escapeHtml(item.organization_name)} · ${escapeHtml(item.category)}</small></span>
              <span>→</span>
            </button>
          `).join("") || '<div class="empty"><strong>No open regressions</strong>Continuous monitoring currently has no unresolved regression.</div>'}
        </div>
      </section>

      <section class="panel">
        <div class="panel-header"><h3>Monitors</h3><span class="chip neutral">${monitors.length}</span></div>
        <div class="monitor-list">
          ${monitors.slice(0,30).map((item)=>`
            <article class="monitor-row">
              <div>
                <strong>${escapeHtml(item.name)}</strong>
                <small>${escapeHtml(item.organization_name)} · ${escapeHtml(item.capability)} · every ${escapeHtml(item.cadence_minutes)}m</small>
              </div>
              <div class="monitor-health">
                ${item.consecutive_failures ? chip(item.consecutive_failures + " failures", "severity-high") : chip("HEALTHY", "verified")}
                ${chip(item.enabled ? "ACTIVE" : "DISABLED", item.enabled ? "verified" : "neutral")}
              </div>
              <button class="button small subtle monitor-toggle" type="button" data-monitor-id="${escapeHtml(item.id)}" data-enabled="${item.enabled ? "true" : "false"}" ${!canOperate ? "disabled" : ""}>${item.enabled ? "Disable" : "Enable"}</button>
            </article>
          `).join("") || '<div class="empty"><strong>No monitors</strong>Create monitoring from a target when recurring checks are needed.</div>'}
        </div>
        ${!canOperate && monitors.length ? '<p class="permission-note">Operator role or higher is required to enable or disable monitors.</p>' : ''}
      </section>
    </div>
  `;

  const table = container.querySelector("#runs-table");
  function draw(filter) {
    const visible = jobs.filter((job) => {
      if (filter === "attention") return ["FAILED","DEAD_LETTER","CANCELLED"].includes(job.state);
      if (filter === "active") return ["QUEUED","RUNNING"].includes(job.state);
      if (filter === "complete") return job.state === "SUCCEEDED";
      return true;
    });
    table.innerHTML = visible.length ? `
      <div class="table-wrap"><table class="table run-table">
        <thead><tr><th>State</th><th>Run</th><th>Target</th><th>Attempts</th><th>Recovery state</th><th>Cost</th><th>Created</th><th></th></tr></thead>
        <tbody>${visible.map((job)=>`
          <tr>
            <td>${chip(job.state)}</td>
            <td><div class="primary-text">${escapeHtml(job.job_type)}</div><div class="secondary-text">${escapeHtml(job.capability)}</div></td>
            <td><button class="button text small run-target" data-target-id="${escapeHtml(job.target_id)}">${escapeHtml(job.organization_name)}</button></td>
            <td>${escapeHtml(job.attempt_count)}/${escapeHtml(job.max_attempts)}</td>
            <td><div class="run-recovery">${escapeHtml(recoveryText(job, fmtDate))}${job.error_code ? '<small>' + escapeHtml(job.error_code) + '</small>' : ''}</div></td>
            <td>${escapeHtml(job.cost_units)}</td>
            <td>${escapeHtml(fmtDate(job.created_at))}</td>
            <td><button class="button text small run-open" data-job-id="${escapeHtml(job.id)}">Inspect</button></td>
          </tr>
        `).join("")}</tbody>
      </table></div>
    ` : '<div class="empty"><strong>No runs in this view</strong>Change the filter or run an authorized assessment.</div>';
    table.querySelectorAll(".run-open").forEach((button) => button.addEventListener("click", () => navigate('/console/runs/' + button.dataset.jobId)));
    table.querySelectorAll(".run-target").forEach((button) => button.addEventListener("click", () => navigate('/console/targets/' + button.dataset.targetId)));
  }
  draw("all");

  container.querySelectorAll(".run-filter").forEach((button) => {
    button.addEventListener("click", () => {
      container.querySelectorAll(".run-filter").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      draw(button.dataset.runFilter);
    });
  });

  container.querySelectorAll(".compact-row[data-target-id]").forEach((button) => {
    button.addEventListener("click", () => navigate('/console/targets/' + button.dataset.targetId));
  });

  container.querySelectorAll(".monitor-toggle").forEach((button) => {
    button.addEventListener("click", async () => {
      const enabled = button.dataset.enabled === "true";
      button.disabled = true;
      try {
        await api('/v1/platform/workspaces/' + workspaceId + '/monitors/' + button.dataset.monitorId + '/' + (enabled ? "disable" : "enable"), {
          method: "POST",
          body: JSON.stringify({}),
        });
        toast('Monitor ' + (enabled ? "disabled" : "enabled"));
        await renderRunsView({ container, api, workspaceId, workspace, fmtDate, navigate, toast });
      } catch (error) {
        button.disabled = false;
        toast(error.message, true);
      }
    });
  });
}
