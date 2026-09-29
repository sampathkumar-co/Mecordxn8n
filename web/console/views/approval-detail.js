import { escapeHtml } from "../components/evidence.js";

function statusChip(value, kind = "") {
  const text = String(value || "UNKNOWN");
  const resolved = kind || (text === "VERIFIED" || text === "CLIENT_AUTHORIZED" || text === "ALLOWED" || text === "APPROVED"
    ? "verified"
    : text === "PENDING" || text === "NOT ALLOWED" || text === "NOT VERIFIED"
      ? "warn"
      : /REJECTED|EXPIRED|FAILED/.test(text)
        ? "severity-high"
        : "neutral");
  return '<span class="status-chip ' + resolved + '">' + escapeHtml(text) + '</span>';
}

function explanation(actionType) {
  return {
    SOURCE_REMEDIATION:
      "Approving allows this remediation request to proceed to the execution queue only if finding verification and current source authorization still pass.",
    REPORT_RELEASE:
      "Approving permits this report to move through the canonical release flow. Public sharing remains tokenized and auditable.",
    OUTBOUND_CONTACT:
      "Approving permits the specific commercial action subject to the current consent, cooldown, and commercial policy checks.",
  }[actionType] || "Approving authorizes only this specific action under current server-side policy checks.";
}

function fmtConfidence(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Math.round(Number(value) * 100) + "%";
}

export async function renderApprovalDetailView({
  container,
  api,
  workspaceId,
  approvalId,
  workspace,
  fmtDate,
  navigate,
  openAuthorization,
  toast,
}) {
  const context = await api('/v1/platform/workspaces/' + workspaceId + '/approvals/' + approvalId);
  const { approval, target, authorization, finding } = context;
  const canDecide = ["OWNER", "ADMIN"].includes(workspace?.role || "");
  const capabilities = authorization?.allowedCapabilities || [];
  const sourceAllowed = capabilities.includes("SOURCE_REMEDIATION");
  const verified = finding?.verification?.status === "VERIFIED";
  const pending = approval.status === "PENDING";
  const expiresAt = approval.expiresAt ? new Date(approval.expiresAt).getTime() : null;
  const expiredByClock = expiresAt != null && expiresAt <= Date.now();

  container.innerHTML = `
    <section class="entity-header approval-detail-header">
      <button id="approval-back" class="button subtle small" type="button">← Approval inbox</button>
      <div class="entity-title-block">
        <div class="entity-badges">
          ${statusChip(approval.status)}
          ${statusChip(approval.actionType, "impact")}
        </div>
        <h2>${escapeHtml({
          SOURCE_REMEDIATION: "Source remediation approval",
          REPORT_RELEASE: "Report release approval",
          OUTBOUND_CONTACT: "Outbound contact approval",
        }[approval.actionType] || "Approval")}</h2>
        <p>${escapeHtml(target?.organizationName || "Target")} · requested by ${escapeHtml(approval.requestedBy || "unknown")} · ${escapeHtml(fmtDate(approval.createdAt))}</p>
      </div>
      <div class="entity-actions">
        ${target?.id ? '<button id="approval-authorization" class="button subtle" type="button">Authorization</button>' : ''}
        ${finding?.id ? '<button id="approval-finding" class="button subtle" type="button">View finding</button>' : ''}
      </div>
    </section>

    <div class="approval-detail-layout">
      <main class="approval-review">
        <section class="panel review-card">
          <p class="eyebrow">REQUEST</p>
          <h3>What this decision permits</h3>
          <p class="review-explanation">${escapeHtml(explanation(approval.actionType))}</p>
          <dl class="review-meta">
            <div><dt>Action</dt><dd>${escapeHtml(approval.actionType)}</dd></div>
            <div><dt>Status</dt><dd>${statusChip(approval.status)}</dd></div>
            <div><dt>Requested by</dt><dd>${escapeHtml(approval.requestedBy || "—")}</dd></div>
            <div><dt>Expires</dt><dd>${escapeHtml(fmtDate(approval.expiresAt))}</dd></div>
            ${approval.payloadSummary?.projectRootConfigured ? '<div><dt>Project scope</dt><dd>Configured · hidden from UI</dd></div>' : ''}
            ${approval.reportId ? '<div><dt>Report</dt><dd>' + escapeHtml(approval.reportId) + '</dd></div>' : ''}
            ${approval.commercialActionId ? '<div><dt>Commercial action</dt><dd>' + escapeHtml(approval.commercialActionId) + '</dd></div>' : ''}
          </dl>
        </section>

        ${finding ? `<section class="panel review-card">
          <div class="panel-header split"><div><p class="eyebrow">PROOF</p><h3>Linked finding</h3></div>${statusChip(finding.verification?.status || "NOT VERIFIED", verified ? "verified" : "warn")}</div>
          <h4 class="review-finding-title">${escapeHtml(finding.title)}</h4>
          <p class="muted">${escapeHtml(finding.category)} · ${escapeHtml(finding.affectedUrl)}</p>
          <div class="review-metrics">
            <div><span>Severity</span><strong>${escapeHtml(finding.severity)}</strong></div>
            <div><span>Confidence</span><strong>${escapeHtml(fmtConfidence(finding.verification?.confidence ?? finding.confidence))}</strong></div>
            <div><span>Opportunity</span><strong>${escapeHtml(finding.intelligence?.opportunityScore == null ? "—" : Number(finding.intelligence.opportunityScore).toFixed(1) + "/100")}</strong></div>
            <div><span>Impact tier</span><strong>${escapeHtml(finding.intelligence?.impactTier || "—")}</strong></div>
          </div>
          ${finding.intelligence?.rationale ? '<div class="rationale"><strong>Why this matters</strong><p>' + escapeHtml(finding.intelligence.rationale) + '</p></div>' : ''}
        </section>` : ''}
      </main>

      <aside class="approval-decision-side">
        <section class="panel decision-card">
          <p class="eyebrow">CURRENT TRUST STATE</p>
          <h3>Authorization gates</h3>
          <div class="trust-stack">
            <div><span>Authorization mode</span>${statusChip(authorization?.mode || "NONE")}</div>
            ${approval.actionType === "SOURCE_REMEDIATION" ? `
              <div><span>Finding verification</span>${statusChip(verified ? "VERIFIED" : "NOT VERIFIED", verified ? "verified" : "warn")}</div>
              <div><span>Source remediation</span>${statusChip(sourceAllowed ? "ALLOWED" : "NOT ALLOWED", sourceAllowed ? "verified" : "warn")}</div>
            ` : ''}
            <div><span>Approval expiry</span>${statusChip(expiredByClock ? "EXPIRED BY CLOCK" : "CURRENT", expiredByClock ? "severity-high" : "verified")}</div>
          </div>
          <p class="permission-note">The backend revalidates policy at execution time. This screen does not bypass current authorization, consent, verification, or lease rules.</p>
        </section>

        <section class="panel decision-card">
          <p class="eyebrow">DECISION</p>
          ${pending ? `
            <label class="decision-note-label">Decision note
              <textarea id="approval-decision-note" rows="4" maxlength="2000" placeholder="Optional audit note"></textarea>
            </label>
            <div class="decision-buttons">
              <button id="approval-reject" class="button danger" type="button" ${(!canDecide || expiredByClock) ? "disabled" : ""}>Reject</button>
              <button id="approval-approve" class="button primary" type="button" ${(!canDecide || expiredByClock) ? "disabled" : ""}>Approve</button>
            </div>
            ${!canDecide ? '<p class="permission-note">Workspace ADMIN or OWNER role is required to decide approvals.</p>' : ''}
            ${expiredByClock ? '<p class="permission-note">This approval has passed its expiry time and cannot be safely decided from the UI.</p>' : ''}
          ` : `
            <div class="decision-history">
              <div><span>Decision</span><strong>${escapeHtml(approval.status)}</strong></div>
              <div><span>Decided by</span><strong>${escapeHtml(approval.decidedBy || "—")}</strong></div>
              <div><span>Decided at</span><strong>${escapeHtml(fmtDate(approval.decidedAt))}</strong></div>
              ${approval.decisionNote ? '<div><span>Note</span><strong>' + escapeHtml(approval.decisionNote) + '</strong></div>' : ''}
            </div>
          `}
        </section>
      </aside>
    </div>
  `;

  container.querySelector("#approval-back")?.addEventListener("click", () => navigate("/console/approvals"));
  container.querySelector("#approval-finding")?.addEventListener("click", () => navigate('/console/findings/' + finding.id));
  container.querySelector("#approval-authorization")?.addEventListener("click", () => openAuthorization(target.id));

  async function decide(decision) {
    const button = container.querySelector(decision === "approve" ? "#approval-approve" : "#approval-reject");
    const other = container.querySelector(decision === "approve" ? "#approval-reject" : "#approval-approve");
    if (button) button.disabled = true;
    if (other) other.disabled = true;
    try {
      await api('/v1/platform/workspaces/' + workspaceId + '/approvals/' + approval.id + '/' + decision, {
        method: "POST",
        body: JSON.stringify({
          decisionNote: container.querySelector("#approval-decision-note")?.value || null,
        }),
      });
      toast('Approval ' + (decision === "approve" ? "approved" : "rejected"));
      await renderApprovalDetailView({
        container,
        api,
        workspaceId,
        approvalId,
        workspace,
        fmtDate,
        navigate,
        openAuthorization,
        toast,
      });
    } catch (error) {
      if (button) button.disabled = false;
      if (other) other.disabled = false;
      toast(error.message, true);
    }
  }

  container.querySelector("#approval-approve")?.addEventListener("click", () => decide("approve"));
  container.querySelector("#approval-reject")?.addEventListener("click", () => decide("reject"));
}
