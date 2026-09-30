import { api, settleRequests } from "../core/api.js";
import { state } from "../core/state.js";
import { permission, disabledAttrs } from "../core/permissions.js";
import { escapeHtml, fmtDate, fmtNumber, safeJson, compactId } from "../core/format.js";
import { chip, detail, entityHeader, panel, partialBanner, setPageMeta, tablePanel, $, $$, toast } from "../components/ui.js";
import { inspectRaw, openRepairRequest } from "../components/actions.js";

export async function renderFindings({ content, signal }) {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/findings?limit=300`, { signal, cacheMs: 5000 });
  if (signal.aborted) return;
  const findings = data.findings || [];

  content.innerHTML = `
    <div class="toolbar">
      <div class="filters">
        <input id="finding-search" type="search" placeholder="Search findings…" aria-label="Search findings">
        <select id="finding-severity"><option value="">All severity</option><option>HIGH</option><option>MEDIUM</option><option>LOW</option><option>INFO</option></select>
        <select id="finding-verification"><option value="">All verification</option><option>VERIFIED</option><option>NOT_REPRODUCED</option><option>PENDING</option></select>
      </div>
      <span class="muted">${findings.filter((f) => f.verificationState === "VERIFIED").length} independently verified</span>
    </div>
    ${tablePanel({
      title: "Evidence-backed findings",
      headers: ["Severity","Finding","Target","Verification","Confidence","Opportunity","Last seen"],
      rows: findings.map((item) => [
        chip(item.severity),
        `<a class="row-link finding-row" data-link href="/console/findings/${item.id}" data-search="${escapeHtml(`${item.title} ${item.category} ${item.affectedUrl} ${item.organizationName}`.toLowerCase())}" data-severity="${escapeHtml(item.severity)}" data-verification="${escapeHtml(item.verificationState)}"><span class="primary-text">${escapeHtml(item.title)}</span><div class="secondary-text">${escapeHtml(item.category)} · ${escapeHtml(item.affectedUrl)}</div></a>`,
        escapeHtml(item.organizationName), chip(item.verificationState),
        `${Math.round(Number(item.confidence || 0) * 100)}%`,
        item.opportunityScore == null ? "—" : `${fmtNumber(item.opportunityScore)}/100`,
        escapeHtml(fmtDate(item.lastSeenAt)),
      ]),
      emptyTitle: "No findings",
      emptyCopy: "Findings appear after authorized QA runs produce evidence.",
      subtitle: "Proof is shown before repair recommendations or commercial value.",
    })}`;
  setPageMeta(`${findings.length} findings`);

  const apply = () => {
    const q = $("#finding-search").value.trim().toLowerCase();
    const sev = $("#finding-severity").value;
    const ver = $("#finding-verification").value;
    $$(".finding-row").forEach((link) => {
      link.closest("tr").hidden =
        (q && !link.dataset.search.includes(q)) ||
        (sev && link.dataset.severity !== sev) ||
        (ver && link.dataset.verification !== ver);
    });
  };
  $("#finding-search").addEventListener("input", apply);
  $("#finding-severity").addEventListener("change", apply);
  $("#finding-verification").addEventListener("change", apply);
}

function evidenceSection(title, value, badge = "") {
  if (value == null) return "";
  const body = typeof value === "string"
    ? `<div class="evidence-body">${escapeHtml(value)}</div>`
    : `<div class="evidence-body"><pre class="code-block">${escapeHtml(safeJson(value))}</pre></div>`;
  return `<section class="evidence-card"><header><strong>${escapeHtml(title)}</strong>${badge ? chip(badge) : ""}</header>${body}</section>`;
}

function artifactCards(artifacts) {
  if (!artifacts.length) return `<div class="evidence-card"><div class="evidence-placeholder"><div><strong>No file artifacts for this finding</strong><br><span>Structured evidence and verification history remain available below.</span></div></div></div>`;
  return artifacts.map((artifact) => `<section class="evidence-card">
    <header><strong>${escapeHtml(artifact.kind)}</strong>${chip("EVIDENCE")}</header>
    <div class="evidence-body">
      <div class="evidence-meta">
        ${detail("Artifact", compactId(artifact.id))}
        ${detail("SHA-256", artifact.sha256 ? `${artifact.sha256.slice(0,16)}…` : "—")}
        ${detail("Bytes", artifact.byte_length ?? "—")}
        ${detail("Captured", fmtDate(artifact.created_at))}
      </div>
      ${artifact.metadata && Object.keys(artifact.metadata).length ? `<details style="margin-top:10px"><summary>Artifact metadata</summary><pre class="code-block">${escapeHtml(safeJson(artifact.metadata))}</pre></details>` : ""}
      <p class="muted" style="margin:10px 0 0">Artifact filesystem paths are intentionally not exposed as public browser URLs.</p>
    </div>
  </section>`).join("");
}

export async function renderFindingDetail({ content, signal, route }) {
  const id = route.params.id;
  const wid = state.workspaceId;
  const finding = await api(`/v1/platform/workspaces/${wid}/findings/${id}`, { signal, cacheMs: 3500 });
  if (signal.aborted) return;
  const { data, errors } = await settleRequests({
    center: api(`/v1/platform/workspaces/${wid}/targets/${finding.target_id}/authorization-center`, { signal, cacheMs: 4000 }),
    approvals: api(`/v1/platform/workspaces/${wid}/approvals?limit=200`, { signal, cacheMs: 5000 }),
    operations: api(`/v1/platform/workspaces/${wid}/operations?limit=250`, { signal, cacheMs: 5000 }),
  });
  if (signal.aborted) return;

  const center = data.center || {};
  const current = center.currentAuthorization || {};
  const capabilities = current.allowed_capabilities || current.allowedCapabilities || [];
  const relatedApprovals = (data.approvals?.approvals || []).filter((a) => a.finding_id === id);
  const remediationApproval = relatedApprovals.find((a) => a.action_type === "SOURCE_REMEDIATION");
  const sourceAuthorized = current.mode === "CLIENT_AUTHORIZED" && capabilities.includes("SOURCE_REMEDIATION");
  const repairAccess = permission("OPERATOR");
  const repairEligible = finding.verification_state === "VERIFIED" && sourceAuthorized && repairAccess.allowed;
  const evidence = finding.evidence || {};
  const verification = finding.verifications?.[0] || null;
  const relatedJobs = (data.operations?.jobs || []).filter((j) => j.target_id === finding.target_id && j.capability === "SOURCE_REMEDIATION");

  const repairReason =
    finding.verification_state !== "VERIFIED" ? "Independent verification is required before source repair." :
    !sourceAuthorized ? "Client authorization with SOURCE_REMEDIATION capability is required." :
    !repairAccess.allowed ? repairAccess.reason :
    "";

  content.innerHTML = `
    ${partialBanner(errors)}
    ${entityHeader({
      eyebrow: `${finding.category} · FINDING`,
      title: finding.title,
      subtitle: finding.affected_url,
      badges: [finding.severity, finding.verification_state, current.mode || "NO AUTHORIZATION"],
      actions: `<a class="button small" data-link href="/console/targets/${finding.target_id}">Target</a><button id="finding-raw" class="button small" type="button">Raw evidence</button>`,
    })}
    <div class="finding-layout">
      <aside class="finding-side stack">
        ${panel("Finding context", `<div class="panel-body detail-grid">
          ${detail("Severity", finding.severity)}${detail("Status", finding.status)}
          ${detail("Confidence", `${Math.round(Number(finding.confidence || 0) * 100)}%`)}
          ${detail("Occurrences", finding.occurrences)}${detail("First seen", fmtDate(finding.first_seen_at))}
          ${detail("Last seen", fmtDate(finding.last_seen_at))}${detail("Impact tier", finding.impact_tier || "—")}
        </div>`)}
        ${panel("Verification", verification ? `<div class="panel-body detail-grid">
          ${detail("Result", verification.status)}${detail("Attempts", verification.attempts)}
          ${detail("Matched", verification.matched_attempts)}${detail("Confidence", `${Math.round(Number(verification.confidence || 0) * 100)}%`)}
        </div>` : '<div class="empty"><strong>No verification record</strong>This signal has not completed independent reproduction.</div>', { badge: finding.verification_state })}
      </aside>

      <main class="proof-stack" aria-label="Evidence">
        ${artifactCards(finding.artifacts || [])}
        ${Object.entries(evidence).map(([key, value]) => evidenceSection(key.replaceAll("_"," "), value)).join("")}
        ${(finding.verifications || []).map((item, index) => evidenceSection(`Verification ${index + 1} · ${fmtDate(item.created_at)}`, item.evidence, item.status)).join("")}
      </main>

      <aside class="finding-side stack">
        ${panel("Decision", `<div class="panel-body">
          <div class="detail-grid">
            ${detail("Business impact", finding.business_impact_score ?? "—")}
            ${detail("Opportunity", finding.opportunity_score == null ? "—" : `${fmtNumber(finding.opportunity_score)}/100`)}
            ${detail("Repair feasibility", finding.repair_feasibility ?? "—")}
            ${detail("Engineering effort", finding.engineering_effort ?? "—")}
            ${detail("Authorization", current.mode || "NONE")}
            ${detail("Approval", remediationApproval?.status || "NOT REQUESTED")}
          </div>
          ${finding.rationale ? `<div class="risk-summary" style="margin-top:10px"><strong>Why it matters</strong><div>${escapeHtml(finding.rationale)}</div></div>` : ""}
          <button id="request-repair" class="button primary full" style="margin-top:10px" type="button" ${repairEligible ? "" : `disabled aria-disabled="true" title="${escapeHtml(repairReason)}"`}>${remediationApproval ? "View repair state" : "Request repair"}</button>
          ${repairReason ? `<p class="muted" style="margin:7px 0 0">${escapeHtml(repairReason)}</p>` : ""}
        </div>`)}
        ${panel("Repair trail", relatedJobs.length ? `<div class="panel-body timeline">${relatedJobs.slice(0,8).map((job) => `<div class="timeline-item"><strong>${escapeHtml(job.state)}</strong><p>${escapeHtml(job.job_type)} · ${escapeHtml(fmtDate(job.created_at))}</p></div>`).join("")}</div>` : '<div class="empty"><strong>No remediation run</strong>Proof exists independently of repair execution.</div>')}
      </aside>
    </div>`;

  $("#finding-raw").addEventListener("click", () => inspectRaw("Raw finding evidence", { evidence: finding.evidence, verifications: finding.verifications, artifacts: finding.artifacts }));
  $("#request-repair").addEventListener("click", () => {
    if (remediationApproval) location.assign(`/console/approvals/${remediationApproval.id}`);
    else openRepairRequest({ id: finding.id });
  });
  setPageMeta(`${finding.organization_name} · evidence first`);
}
