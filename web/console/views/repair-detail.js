import { escapeHtml } from "../components/evidence.js";

function chip(value, kind = "") {
  const text = String(value || "UNKNOWN");
  const resolved = kind || (/SUCCESS|SUCCEEDED|VERIFIED|APPROVED|CLIENT_AUTHORIZED|ALLOWED/.test(text)
    ? "verified"
    : /FAILED|BLOCKED|DEAD_LETTER|CANCELLED|REJECTED|EXPIRED/.test(text)
      ? "severity-high"
      : /PENDING|QUEUED|PARTIAL/.test(text)
        ? "warn"
        : /RUNNING/.test(text)
          ? "impact"
          : "neutral");
  return '<span class="status-chip ' + resolved + '">' + escapeHtml(text) + '</span>';
}

function stageOf(repair) {
  if (repair.outcome?.status === "SUCCESS") return "SUCCEEDED";
  if (repair.outcome?.status === "PARTIAL") return "PARTIAL";
  if (repair.outcome?.status === "FAILED") return "FAILED";
  if (["FAILED","DEAD_LETTER","CANCELLED"].includes(repair.job?.state)) return "FAILED";
  if (repair.requestStatus === "BLOCKED") return "BLOCKED";
  if (repair.job?.state === "RUNNING") return "EXECUTING";
  if (repair.job?.state === "QUEUED" || repair.requestStatus === "QUEUED") return "QUEUED";
  if (repair.requestStatus === "SUCCEEDED") return "VERIFYING";
  return repair.requestStatus || repair.job?.state || "UNKNOWN";
}

function timelineItem(label, state, time, detail = "") {
  return '<li class="' + (state ? "done" : "") + '">' +
    '<span class="repair-timeline-dot"></span>' +
    '<div><strong>' + escapeHtml(label) + '</strong>' +
    '<small>' + escapeHtml(time || "Not reached") + '</small>' +
    (detail ? '<p>' + escapeHtml(detail) + '</p>' : '') +
    '</div></li>';
}

export async function renderRepairDetailView({
  container,
  api,
  workspaceId,
  repairId,
  fmtDate,
  navigate,
}) {
  const repair = await api('/v1/platform/workspaces/' + workspaceId + '/repairs/' + repairId);
  const stage = stageOf(repair);
  const auth = repair.currentAuthorization;
  const authExpired = auth?.expiresAt && new Date(auth.expiresAt).getTime() <= Date.now();
  const sourceAllowed = Boolean(auth?.allowedCapabilities?.includes("SOURCE_REMEDIATION"));

  container.innerHTML = `
    <section class="entity-header">
      <button id="repair-back" class="button subtle small" type="button">← Repairs</button>
      <div class="entity-title-block">
        <div class="entity-badges">
          ${chip(stage)}
          ${chip(repair.finding.severity, repair.finding.severity === "HIGH" ? "severity-high" : "neutral")}
        </div>
        <h2>${escapeHtml(repair.finding.title)}</h2>
        <p>${escapeHtml(repair.target.organizationName)} · ${escapeHtml(repair.finding.category)} · repair ${escapeHtml(repair.id.slice(0,8))}</p>
      </div>
      <div class="entity-actions">
        <button id="repair-finding" class="button subtle" type="button">Finding</button>
        <button id="repair-run" class="button subtle" type="button">Run</button>
        <button id="repair-target" class="button primary" type="button">Target</button>
      </div>
    </section>

    <div class="repair-detail-layout">
      <main class="repair-detail-main">
        <section class="panel review-card">
          <div class="panel-header split"><div><p class="eyebrow">LIFECYCLE</p><h3>Repair progression</h3></div>${chip(stage)}</div>
          <ol class="repair-timeline">
            ${timelineItem("Verified finding", repair.finding.verification?.status === "VERIFIED", fmtDate(repair.finding.verification?.createdAt), repair.finding.verification ? "Independent verification confidence " + Math.round(Number(repair.finding.verification.confidence || 0) * 100) + "%" : "")}
            ${timelineItem("Human approval", repair.approval?.status === "APPROVED", fmtDate(repair.approval?.decidedAt), repair.approval ? "Decision by " + (repair.approval.decidedBy || "unknown") : "Approval context unavailable")}
            ${timelineItem("Repair queued", Boolean(repair.job?.createdAt), fmtDate(repair.job?.createdAt), repair.job ? repair.job.attemptCount + "/" + repair.job.maxAttempts + " attempts used" : "")}
            ${timelineItem("Execution started", Boolean(repair.job?.startedAt), fmtDate(repair.job?.startedAt), repair.job?.state || "")}
            ${timelineItem("Execution completed", Boolean(repair.job?.completedAt), fmtDate(repair.job?.completedAt), repair.job?.errorCode ? "Safe failure code: " + repair.job.errorCode : "")}
            ${timelineItem("Outcome recorded", Boolean(repair.outcome), fmtDate(repair.outcome?.createdAt), repair.outcome?.status || "")}
          </ol>
        </section>

        <section class="panel review-card">
          <div class="panel-header split"><div><p class="eyebrow">PROOF</p><h3>Finding context</h3></div>${chip(repair.finding.verification?.status || "NOT VERIFIED")}</div>
          <div class="review-metrics">
            <div><span>Severity</span><strong>${escapeHtml(repair.finding.severity)}</strong></div>
            <div><span>Confidence</span><strong>${escapeHtml(Math.round(Number(repair.finding.verification?.confidence ?? repair.finding.confidence) * 100) + "%")}</strong></div>
            <div><span>Opportunity</span><strong>${escapeHtml(repair.finding.intelligence?.opportunityScore == null ? "—" : Number(repair.finding.intelligence.opportunityScore).toFixed(1) + "/100")}</strong></div>
            <div><span>Impact</span><strong>${escapeHtml(repair.finding.intelligence?.impactTier || "—")}</strong></div>
          </div>
          <p class="muted repair-url">${escapeHtml(repair.finding.affectedUrl || "Authorized route")}</p>
          ${repair.finding.intelligence?.rationale ? '<div class="rationale"><strong>Why the repair matters</strong><p>' + escapeHtml(repair.finding.intelligence.rationale) + '</p></div>' : ''}
        </section>

        <section class="panel repair-outcome-card">
          <p class="eyebrow">VALIDATION OUTCOME</p>
          ${repair.outcome
            ? '<div class="repair-outcome-head">' + chip(repair.outcome.status) + '<span>' + escapeHtml(fmtDate(repair.outcome.createdAt)) + '</span></div><h3>' + escapeHtml(repair.outcome.summary) + '</h3><p class="muted">This is the sanitized repair outcome. Raw MCP output and source details remain private.</p>'
            : '<div class="empty"><strong>No outcome recorded yet</strong>The repair worker has not recorded a final sanitized outcome.</div>'}
        </section>
      </main>

      <aside class="repair-detail-side">
        <section class="panel decision-card">
          <p class="eyebrow">CURRENT AUTHORIZATION</p>
          <h3>${escapeHtml(auth?.mode || "No active authorization")}</h3>
          <div class="trust-stack">
            <div><span>Mode</span>${chip(auth?.mode || "NONE")}</div>
            <div><span>Source remediation</span>${chip(sourceAllowed ? "ALLOWED" : "NOT ALLOWED", sourceAllowed ? "verified" : "warn")}</div>
            <div><span>Expiry</span>${chip(authExpired ? "EXPIRED" : auth?.expiresAt ? fmtDate(auth.expiresAt) : "NO EXPIRY", authExpired ? "severity-high" : "neutral")}</div>
          </div>
          <p class="permission-note">This is current trust state for recovery/context. The repair remains audit-linked to the approval and authorization checks used when its job was queued.</p>
        </section>

        <section class="panel decision-card">
          <p class="eyebrow">APPROVAL</p>
          ${repair.approval ? `
            <div class="trust-stack">
              <div><span>Status</span>${chip(repair.approval.status)}</div>
              <div><span>Requested by</span><strong>${escapeHtml(repair.approval.requestedBy || "—")}</strong></div>
              <div><span>Decided by</span><strong>${escapeHtml(repair.approval.decidedBy || "—")}</strong></div>
            </div>
            ${repair.approval.decisionNote ? '<div class="rationale"><strong>Decision note</strong><p>' + escapeHtml(repair.approval.decisionNote) + '</p></div>' : ''}
            <button id="repair-approval" class="button subtle full-width" type="button">Open approval record</button>
          ` : '<div class="empty">Approval record unavailable.</div>'}
        </section>

        <section class="panel decision-card">
          <p class="eyebrow">PRIVACY</p>
          <p class="muted">The workspace API does not expose the authorized project root, MCP request/result, raw job input/output/error, worker identity, or repair-learning internals.</p>
        </section>
      </aside>
    </div>
  `;

  container.querySelector("#repair-back")?.addEventListener("click", () => navigate("/console/repairs"));
  container.querySelector("#repair-finding")?.addEventListener("click", () => navigate('/console/findings/' + repair.findingId));
  container.querySelector("#repair-run")?.addEventListener("click", () => navigate('/console/runs/' + repair.jobId));
  container.querySelector("#repair-target")?.addEventListener("click", () => navigate('/console/targets/' + repair.targetId));
  container.querySelector("#repair-approval")?.addEventListener("click", () => {
    if (repair.approval?.id) navigate('/console/approvals/' + repair.approval.id);
  });
}
