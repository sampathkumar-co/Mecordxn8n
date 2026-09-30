import { api, settleRequests } from "../core/api.js";
import { state } from "../core/state.js";
import { escapeHtml, fmtDate } from "../core/format.js";
import { chip, detail, entityHeader, panel, partialBanner, setPageMeta, $, tablePanel } from "../components/ui.js";
import { openRepairRequest } from "../components/actions.js";

function repairStage(finding, approvals, jobs) {
  const approval = approvals.find((item) => item.finding_id === finding.id && item.action_type === "SOURCE_REMEDIATION");
  const job = jobs.find((item) => item.finding_id === finding.id && item.capability === "SOURCE_REMEDIATION");
  if (job) {
    if (job.state === "SUCCEEDED") return { id: "succeeded", label: "Succeeded", approval, job };
    if (["FAILED","DEAD_LETTER","CANCELLED"].includes(job.state)) return { id: "failed", label: "Failed / aborted", approval, job };
    if (job.state === "RUNNING") return { id: "executing", label: "Executing", approval, job };
    return { id: "queued", label: "Queued", approval, job };
  }
  if (approval?.status === "PENDING") return { id: "approval", label: "Awaiting approval", approval };
  if (approval?.status === "APPROVED") return { id: "queued", label: "Approved / queueing", approval };
  if (approval?.status === "REJECTED") return { id: "failed", label: "Rejected", approval };
  return { id: "eligible", label: "Eligible", approval: null };
}

export async function renderRepairs({ content, signal }) {
  const wid = state.workspaceId;
  const { data, errors } = await settleRequests({
    findings: api(`/v1/platform/workspaces/${wid}/findings?limit=400`, { signal, cacheMs: 4500 }),
    approvals: api(`/v1/platform/workspaces/${wid}/approvals?limit=400`, { signal, cacheMs: 4500 }),
    operations: api(`/v1/platform/workspaces/${wid}/operations?limit=400`, { signal, cacheMs: 4500 }),
  });
  if (signal.aborted) return;

  const findings = (data.findings?.findings || []).filter((item) => item.verificationState === "VERIFIED");
  const approvals = data.approvals?.approvals || [];
  const jobs = data.operations?.jobs || [];
  const items = findings.map((finding) => ({ finding, stage: repairStage(finding, approvals, jobs) }));
  const columns = [
    ["eligible","Eligible"],["approval","Awaiting approval"],["queued","Queued"],["executing","Executing"],["succeeded","Succeeded"],["failed","Failed / aborted"],
  ];

  content.innerHTML = `
    ${partialBanner(errors)}
    ${entityHeader({ eyebrow:"REPAIR", title:"Repair queue", subtitle:"Verified proof moves through authorization, approval, execution, and post-repair verification.", badges:[`${items.length} VERIFIED SIGNALS`] })}
    <div class="lifecycle">${columns.map(([id,label]) => {
      const group = items.filter((item) => item.stage.id === id);
      return `<section class="lifecycle-col"><div class="lifecycle-head">${escapeHtml(label)} · ${group.length}</div>${group.map(({finding,stage}) => `<a class="lifecycle-card" data-link href="/console/repairs/${finding.id}"><strong>${escapeHtml(finding.title)}</strong><p>${escapeHtml(finding.organizationName)} · ${escapeHtml(finding.severity)} · ${escapeHtml(stage.label)}</p></a>`).join("") || '<div class="empty">Empty</div>'}</section>`;
    }).join("")}</div>`;
  setPageMeta("Source repair never bypasses explicit approval or current authorization");
}

export async function renderRepairDetail({ content, signal, route }) {
  const wid = state.workspaceId;
  const id = route.params.id;
  const finding = await api(`/v1/platform/workspaces/${wid}/findings/${id}`, { signal, cacheMs: 3000 });
  const { data, errors } = await settleRequests({
    approvals: api(`/v1/platform/workspaces/${wid}/approvals?limit=400`, { signal, cacheMs: 3500 }),
    operations: api(`/v1/platform/workspaces/${wid}/operations?limit=400`, { signal, cacheMs: 3500 }),
    center: api(`/v1/platform/workspaces/${wid}/targets/${finding.target_id}/authorization-center`, { signal, cacheMs: 3500 }),
  });
  if (signal.aborted) return;
  const approvals = data.approvals?.approvals || [];
  const jobs = data.operations?.jobs || [];
  const stage = repairStage({ id, ...finding }, approvals, jobs);
  const current = data.center?.currentAuthorization || {};
  const verifications = finding.verifications || [];

  content.innerHTML = `
    ${partialBanner(errors)}
    ${entityHeader({
      eyebrow:"REPAIR DETAIL", title:finding.title, subtitle:finding.organization_name,
      badges:[stage.label, finding.verification_state, current.mode || "NO AUTHORIZATION"],
      actions:`<a class="button small" data-link href="/console/findings/${id}">Open proof</a>${stage.id === "eligible" ? '<button id="repair-detail-request" class="button primary small" type="button">Request repair</button>' : ""}`,
    })}
    <div class="split">
      ${panel("Repair state", `<div class="panel-body detail-grid">
        ${detail("Lifecycle", stage.label)}${detail("Approval", stage.approval?.status || "NOT REQUESTED")}
        ${detail("Job", stage.job?.state || "NOT QUEUED")}${detail("Attempts", stage.job ? `${stage.job.attempt_count}/${stage.job.max_attempts}` : "—")}
        ${detail("Worker", stage.job?.worker_id || "—")}${detail("Last heartbeat", stage.job?.last_heartbeat_at ? fmtDate(stage.job.last_heartbeat_at) : "—")}
      </div>`)}
      ${panel("Execution authority", `<div class="panel-body detail-grid">
        ${detail("Authorization", current.mode || "NONE")}${detail("Capabilities", (current.allowed_capabilities || current.allowedCapabilities || []).join(", ") || "—")}
        ${detail("Affected URL", finding.affected_url)}${detail("Approval identity", stage.approval?.decided_by || stage.approval?.requested_by || "—")}
      </div>`)}
    </div>
    <div class="split">
      ${panel("Root cause & engineering context", `<div class="panel-body"><div class="detail-grid">${detail("Category", finding.category)}${detail("Repair feasibility", finding.repair_feasibility ?? "—")}${detail("Engineering effort", finding.engineering_effort ?? "—")}${detail("Impact tier", finding.impact_tier || "—")}</div>${finding.rationale ? `<p style="margin:10px 0 0">${escapeHtml(finding.rationale)}</p>` : ""}</div>`)}
      ${panel("Before / after verification", `<div class="panel-body timeline">${verifications.map((item) => `<div class="timeline-item"><strong>${escapeHtml(item.status)}</strong><p>${escapeHtml(fmtDate(item.created_at))} · ${escapeHtml(item.matched_attempts)}/${escapeHtml(item.attempts)} attempts matched</p></div>`).join("") || '<span class="muted">No verification history.</span>'}<p class="muted" style="margin-top:10px">Raw remediation output is intentionally excluded from this UI. Only evidence-backed verification state is surfaced.</p></div>`)}
    </div>`;
  $("#repair-detail-request")?.addEventListener("click", () => openRepairRequest({ id }));
  setPageMeta(`Repair lifecycle · ${stage.label}`);
}
