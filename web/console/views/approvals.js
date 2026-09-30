import { api, settleRequests } from "../core/api.js";
import { state } from "../core/state.js";
import { permission, disabledAttrs } from "../core/permissions.js";
import { escapeHtml, fmtDate, fmtRelative, compactId } from "../core/format.js";
import { chip, detail, entityHeader, panel, partialBanner, setPageMeta, $, toast } from "../components/ui.js";
import { decideApproval } from "../components/actions.js";

const groups = [
  ["SOURCE_REMEDIATION", "Source remediation", "Authorized source changes"],
  ["REPORT_RELEASE", "Report release", "External report visibility"],
  ["OUTBOUND_CONTACT", "Outbound commercial action", "Consent-safe customer contact"],
];

function approvalCard(item) {
  const expired = new Date(item.expires_at).getTime() <= Date.now() && item.status === "PENDING";
  return `<article class="approval-card">
    <div>
      <h3><a data-link href="/console/approvals/${item.id}">${escapeHtml(item.action_type.replaceAll("_"," "))}</a></h3>
      <div class="approval-meta"><span>${escapeHtml(item.organization_name)}</span><span>Requested by ${escapeHtml(item.requested_by)}</span><span>${escapeHtml(fmtRelative(item.created_at))}</span><span>${expired ? "Expired" : `Expires ${escapeHtml(fmtRelative(item.expires_at))}`}</span></div>
    </div>
    <div class="approval-actions">${chip(expired ? "EXPIRED" : item.status)}${item.status === "PENDING" && !expired ? `<a class="button small primary" data-link href="/console/approvals/${item.id}">Review</a>` : ""}</div>
  </article>`;
}

export async function renderApprovals({ content, signal }) {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/approvals?limit=300`, { signal, cacheMs: 3500 });
  if (signal.aborted) return;
  const approvals = data.approvals || [];
  const pending = approvals.filter((item) => item.status === "PENDING");

  content.innerHTML = `
    <div class="entity-header"><div><p class="eyebrow">HUMAN GATES</p><h1>Approval inbox</h1><div class="entity-subtitle">High-impact actions are product objects, not generic confirmation dialogs.</div></div><div class="entity-actions">${chip(`${pending.length} PENDING`)}</div></div>
    <div class="approval-groups">
      ${groups.map(([type,label,copy]) => {
        const items = approvals.filter((item) => item.action_type === type);
        return panel(label, items.length ? `<div>${items.map(approvalCard).join("")}</div>` : `<div class="empty"><strong>No ${escapeHtml(label.toLowerCase())} requests</strong>${escapeHtml(copy)} requests will appear here.</div>`, { badge: String(items.filter((i)=>i.status==="PENDING").length), subtitle: copy });
      }).join("")}
      ${approvals.filter((item) => !groups.some(([type]) => type === item.action_type)).length ? panel("Other approval types", `<div>${approvals.filter((item) => !groups.some(([type]) => type === item.action_type)).map(approvalCard).join("")}</div>`) : ""}
    </div>`;
  setPageMeta(`${pending.length} waiting · decisions are never auto-retried`);
}

export async function renderApprovalDetail({ content, signal, route }) {
  const wid = state.workspaceId;
  const id = route.params.id;
  const approvalsData = await api(`/v1/platform/workspaces/${wid}/approvals?limit=400`, { signal, cacheMs: 3000 });
  const approval = (approvalsData.approvals || []).find((item) => item.id === id);
  if (!approval) throw Object.assign(new Error("Approval not found in this workspace."), { status: 404 });

  const requests = {
    center: api(`/v1/platform/workspaces/${wid}/targets/${approval.target_id}/authorization-center`, { signal, cacheMs: 3500 }),
  };
  if (approval.finding_id) {
    requests.finding = api(`/v1/platform/workspaces/${wid}/findings/${approval.finding_id}`, { signal, cacheMs: 3500 });
  }
  const { data, errors } = await settleRequests(requests);
  if (signal.aborted) return;

  const current = data.center?.currentAuthorization || {};
  const capabilities = current.allowed_capabilities || current.allowedCapabilities || [];
  const expired = new Date(approval.expires_at).getTime() <= Date.now() && approval.status === "PENDING";
  const access = permission("ADMIN");
  const canDecide = approval.status === "PENDING" && !expired && access.allowed;

  content.innerHTML = `
    ${partialBanner(errors)}
    ${entityHeader({
      eyebrow: "APPROVAL",
      title: approval.action_type.replaceAll("_"," "),
      subtitle: `${approval.organization_name} · requested by ${approval.requested_by}`,
      badges: [expired ? "EXPIRED" : approval.status, current.mode || "NO AUTHORIZATION"],
      actions: `<a class="button small" data-link href="/console/approvals">Back to inbox</a>`,
    })}
    <div class="split">
      ${panel("Decision context", `<div class="panel-body">
        <div class="detail-grid">
          ${detail("Target", approval.organization_name)}
          ${detail("Requested", fmtDate(approval.created_at))}
          ${detail("Expires", `${fmtDate(approval.expires_at)} · ${fmtRelative(approval.expires_at)}`)}
          ${detail("Requester", approval.requested_by)}
          ${detail("Finding", approval.finding_id ? compactId(approval.finding_id) : "—")}
          ${detail("Report", approval.report_id ? compactId(approval.report_id) : "—")}
          ${detail("Commercial action", approval.commercial_action_id ? compactId(approval.commercial_action_id) : "—")}
          ${detail("Decision by", approval.decided_by || "—")}
        </div>
        ${approval.decision_note ? `<div class="risk-summary" style="margin-top:10px"><strong>Decision note</strong><div>${escapeHtml(approval.decision_note)}</div></div>` : ""}
      </div>`)}
      ${panel("Current authorization", `<div class="panel-body">
        <div class="detail-grid">
          ${detail("Mode", current.mode || "NONE")}${detail("Capabilities", capabilities.join(", ") || "—")}
          ${detail("Allowed hosts", (current.allowed_hosts || current.allowedHosts || []).join(", ") || "—")}
          ${detail("Expires", current.expires_at ? fmtDate(current.expires_at) : "No expiry")}
        </div>
        <p class="muted" style="margin:10px 0 0">Approval does not override authorization. The server revalidates current scope again before the gated action executes.</p>
      </div>`, { badge: current.mode || "NONE" })}
    </div>
    ${data.finding ? `<div style="margin-top:10px">${panel("Linked proof", `<div class="panel-body"><strong>${escapeHtml(data.finding.title)}</strong><p class="muted">${escapeHtml(data.finding.affected_url)}</p><div class="filters">${chip(data.finding.severity)}${chip(data.finding.verification_state)}<a class="button small" data-link href="/console/findings/${data.finding.id}">Open evidence</a></div></div>`)}</div>` : ""}
    <div style="margin-top:10px">${panel("Decision", `<div class="panel-body">
      ${expired ? '<div class="risk-summary"><strong>This request expired.</strong><div>Create a fresh request so authorization and evidence are evaluated again.</div></div>' : ""}
      <div class="filters"><button id="approval-approve" class="button primary" type="button" ${canDecide ? "" : `disabled title="${escapeHtml(access.reason || "Only pending, non-expired requests can be decided.")}"`}>Approve action</button><button id="approval-reject" class="button danger" type="button" ${canDecide ? "" : "disabled"}>Reject action</button></div>
    </div>`)}</div>`;

  $("#approval-approve")?.addEventListener("click", () => decideApproval(approval, "approve").catch((e)=>toast(e.message,true)));
  $("#approval-reject")?.addEventListener("click", () => decideApproval(approval, "reject").catch((e)=>toast(e.message,true)));
  setPageMeta(`${approval.status} · ${fmtRelative(approval.expires_at)}`);
}
