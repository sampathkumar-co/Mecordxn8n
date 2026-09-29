import { escapeHtml } from "../components/evidence.js";

function chip(value, kind = "") {
  const text = String(value || "UNKNOWN");
  const resolved = kind || (text === "SUCCEEDED" || text === "ACTIVE" || text === "ALLOWED"
    ? "verified"
    : text === "RUNNING"
      ? "impact"
      : text === "QUEUED"
        ? "warn"
        : /DEAD_LETTER|FAILED|CANCELLED|DO_NOT_TEST|EXPIRED/.test(text)
          ? "severity-high"
          : "neutral");
  return '<span class="status-chip ' + resolved + '">' + escapeHtml(text) + '</span>';
}

function recoveryModel(job, authCurrent, fmtDate) {
  if (job.state === "QUEUED" && job.nextAttemptAt) {
    return {
      title: "Automatic retry scheduled",
      copy: "The control plane kept this run within its retry budget and will make it eligible again at " + fmtDate(job.nextAttemptAt) + ". No manual replay is needed.",
      kind: "warn",
    };
  }
  if (job.state === "QUEUED") {
    return {
      title: "Waiting for an eligible worker",
      copy: "This run is queued. The control plane will lease it only while authorization, retry budget, and target concurrency rules continue to pass.",
      kind: "neutral",
    };
  }
  if (job.state === "RUNNING") {
    return {
      title: "Execution is active",
      copy: "A worker currently owns this run. Do not create a duplicate. Lease and authorization checks remain active while it executes.",
      kind: "impact",
    };
  }
  if (job.state === "DEAD_LETTER") {
    return {
      title: "Retry budget exhausted",
      copy: authCurrent
        ? "This run is terminal. Inspect the failure code and target state, then start a fresh authorized assessment from the target only after the underlying issue is understood."
        : "This run is terminal and the target no longer has compatible current authorization. Restore or replace authorization before any new assessment.",
      kind: "severity-high",
    };
  }
  if (job.state === "FAILED") {
    return {
      title: "Run failed",
      copy: "This execution is terminal. Inspect the safe failure code and target authorization before starting a new assessment.",
      kind: "severity-high",
    };
  }
  if (job.state === "CANCELLED") {
    return {
      title: "Run cancelled",
      copy: "Cancellation is terminal. Authorization replacement/revocation or another control-plane decision may have invalidated this work. Inspect the target trust state before running again.",
      kind: "severity-high",
    };
  }
  if (job.state === "SUCCEEDED") {
    return {
      title: "Run completed",
      copy: "The execution finished successfully. Findings and evidence created by the run remain available through the engineering views.",
      kind: "verified",
    };
  }
  return { title: "Inspect run state", copy: "Review target authorization and run metadata before taking another action.", kind: "neutral" };
}

export async function renderRunDetailView({
  container,
  api,
  workspaceId,
  jobId,
  workspace,
  fmtDate,
  navigate,
}) {
  const job = await api('/v1/platform/workspaces/' + workspaceId + '/jobs/' + jobId);
  const auth = job.currentAuthorization;
  const authExpired = auth?.expiresAt && new Date(auth.expiresAt).getTime() <= Date.now();
  const capabilityAllowed = Boolean(auth?.allowedCapabilities?.includes(job.capability));
  const authCurrent = Boolean(auth && auth.mode !== "DO_NOT_TEST" && !authExpired && capabilityAllowed);
  const recovery = recoveryModel(job, authCurrent, fmtDate);
  const canOperate = ["OWNER","ADMIN","OPERATOR"].includes(workspace?.role || "");

  container.innerHTML = `
    <section class="entity-header">
      <button id="run-back" class="button subtle small" type="button">← Runs</button>
      <div class="entity-title-block">
        <div class="entity-badges">
          ${chip(job.state)}
          ${chip(job.capability, "impact")}
        </div>
        <h2>${escapeHtml(job.jobType)}</h2>
        <p>${escapeHtml(job.organizationName)} · ${escapeHtml(job.requestedUrl || job.targetBaseUrl || "Authorized target")}</p>
      </div>
      <div class="entity-actions">
        <button id="run-target" class="button primary" type="button">Open target</button>
      </div>
    </section>

    <div class="run-detail-layout">
      <main class="run-detail-main">
        <section class="panel review-card">
          <div class="panel-header split"><div><p class="eyebrow">EXECUTION</p><h3>Run state</h3></div>${chip(job.state)}</div>
          <div class="review-metrics run-metrics">
            <div><span>Attempts</span><strong>${escapeHtml(job.attemptCount)}/${escapeHtml(job.maxAttempts)}</strong></div>
            <div><span>Cost units</span><strong>${escapeHtml(job.costUnits)}</strong></div>
            <div><span>Created</span><strong>${escapeHtml(fmtDate(job.createdAt))}</strong></div>
            <div><span>Started</span><strong>${escapeHtml(fmtDate(job.startedAt))}</strong></div>
            <div><span>Completed</span><strong>${escapeHtml(fmtDate(job.completedAt))}</strong></div>
            <div><span>Last heartbeat</span><strong>${escapeHtml(fmtDate(job.lastHeartbeatAt))}</strong></div>
            <div><span>Next attempt</span><strong>${escapeHtml(fmtDate(job.nextAttemptAt))}</strong></div>
            <div><span>Safe failure code</span><strong>${escapeHtml(job.errorCode || "—")}</strong></div>
          </div>
        </section>

        <section class="panel recovery-card ${escapeHtml(recovery.kind)}">
          <p class="eyebrow">RECOVERY</p>
          <h3>${escapeHtml(recovery.title)}</h3>
          <p>${escapeHtml(recovery.copy)}</p>
          ${["DEAD_LETTER","FAILED","CANCELLED"].includes(job.state) && canOperate
            ? '<button id="run-new-assessment" class="button primary" type="button">Inspect target & run new assessment</button>'
            : ''}
        </section>

        <section class="panel review-card">
          <p class="eyebrow">PRIVACY BOUNDARY</p>
          <h3>Safe operational detail only</h3>
          <p class="muted">Raw job input, worker output, raw error messages, lease owner identity, logs, source paths, credentials, and MCP responses are intentionally not returned by this workspace endpoint.</p>
        </section>
      </main>

      <aside class="run-detail-side">
        <section class="panel decision-card">
          <p class="eyebrow">CURRENT AUTHORIZATION</p>
          <h3>${escapeHtml(auth?.mode || "No active authorization")}</h3>
          <div class="trust-stack">
            <div><span>Mode</span>${chip(auth?.mode || "NONE")}</div>
            <div><span>Capability</span>${chip(capabilityAllowed ? "ALLOWED" : "NOT ALLOWED", capabilityAllowed ? "verified" : "warn")}</div>
            <div><span>Expiry</span>${chip(authExpired ? "EXPIRED" : auth?.expiresAt ? fmtDate(auth.expiresAt) : "NO EXPIRY", authExpired ? "severity-high" : "neutral")}</div>
            <div><span>Safe to start equivalent work</span>${chip(authCurrent ? "YES" : "NO", authCurrent ? "verified" : "warn")}</div>
          </div>
          <p class="permission-note">Current authorization is shown for recovery decisions. It does not retroactively change the authorization snapshot under which this run was originally queued.</p>
        </section>

        <section class="panel decision-card">
          <p class="eyebrow">TARGET</p>
          <h3>${escapeHtml(job.organizationName)}</h3>
          <p class="muted">${escapeHtml(job.targetBaseUrl || "Authorized target")}</p>
          <button id="run-target-secondary" class="button subtle full-width" type="button">Open target trust state</button>
        </section>
      </aside>
    </div>
  `;

  const openTarget = () => navigate('/console/targets/' + job.targetId);
  container.querySelector("#run-back")?.addEventListener("click", () => navigate("/console/runs"));
  container.querySelector("#run-target")?.addEventListener("click", openTarget);
  container.querySelector("#run-target-secondary")?.addEventListener("click", openTarget);
  container.querySelector("#run-new-assessment")?.addEventListener("click", openTarget);
}
