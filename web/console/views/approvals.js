import { escapeHtml } from "../components/evidence.js";

function statusChip(value) {
  const text = String(value || "UNKNOWN");
  const kind = text === "PENDING"
    ? "warn"
    : text === "APPROVED"
      ? "verified"
      : /REJECTED|EXPIRED/.test(text)
        ? "severity-high"
        : "neutral";
  return '<span class="status-chip ' + kind + '">' + escapeHtml(text) + '</span>';
}

function typeLabel(value) {
  return {
    SOURCE_REMEDIATION: "Source remediation",
    REPORT_RELEASE: "Report release",
    OUTBOUND_CONTACT: "Outbound contact",
  }[value] || String(value || "Approval");
}

export async function renderApprovalsView({
  container,
  api,
  workspaceId,
  fmtDate,
  navigate,
}) {
  const data = await api('/v1/platform/workspaces/' + workspaceId + '/approvals?limit=200');
  const approvals = data.approvals || [];
  const pending = approvals.filter((item) => item.status === "PENDING");
  const decided = approvals.filter((item) => item.status !== "PENDING");

  container.innerHTML = `
    <section class="queue-summary">
      <div>
        <p class="eyebrow">HUMAN GATES</p>
        <h2>Approval inbox</h2>
        <p>Review evidence and current authorization before making a decision.</p>
      </div>
      <div class="queue-counts">
        <div><strong>${pending.length}</strong><span>Waiting</span></div>
        <div><strong>${decided.length}</strong><span>Decided</span></div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header split">
        <div><h3>Waiting for decision</h3><p class="muted">Oldest and nearest expiry should be reviewed first.</p></div>
        <span class="chip ${pending.length ? "neutral" : "good"}">${pending.length}</span>
      </div>
      <div class="approval-queue">
        ${pending.length ? pending.map((item) => `
          <button class="approval-row" type="button" data-approval-id="${escapeHtml(item.id)}">
            <span class="approval-icon" aria-hidden="true">✓</span>
            <span class="approval-main">
              <strong>${escapeHtml(typeLabel(item.action_type))}</strong>
              <small>${escapeHtml(item.organization_name || "Target")} · requested by ${escapeHtml(item.requested_by || "unknown")}</small>
            </span>
            <span class="approval-expiry"><small>Expires</small><strong>${escapeHtml(fmtDate(item.expires_at))}</strong></span>
            <span class="approval-status">${statusChip(item.status)}</span>
            <span aria-hidden="true">→</span>
          </button>
        `).join("") : '<div class="empty"><strong>Nothing waiting</strong>No human-gated operation currently needs a decision.</div>'}
      </div>
    </section>

    <section class="panel decided-panel">
      <div class="panel-header"><h3>Decision history</h3><span class="chip neutral">${decided.length}</span></div>
      ${decided.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Action</th><th>Target</th><th>Status</th><th>Decided by</th><th>Decision time</th><th></th></tr></thead>
        <tbody>${decided.map((item) => `<tr>
          <td><span class="primary-text">${escapeHtml(typeLabel(item.action_type))}</span></td>
          <td>${escapeHtml(item.organization_name || "—")}</td>
          <td>${statusChip(item.status)}</td>
          <td>${escapeHtml(item.decided_by || "—")}</td>
          <td>${escapeHtml(fmtDate(item.decided_at))}</td>
          <td><button class="button text small approval-history-open" data-approval-id="${escapeHtml(item.id)}">View</button></td>
        </tr>`).join("")}</tbody>
      </table></div>` : '<div class="empty">No decided approvals yet.</div>'}
    </section>
  `;

  container.querySelectorAll("[data-approval-id]").forEach((button) => {
    button.addEventListener("click", () => {
      navigate('/console/approvals/' + button.dataset.approvalId);
    });
  });
}
