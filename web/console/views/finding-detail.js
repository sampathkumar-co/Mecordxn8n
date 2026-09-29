import {
  escapeHtml,
  renderArtifacts,
  renderEvidenceObject,
  renderVerificationTimeline,
} from "../components/evidence.js";

function chip(value, kind = "") {
  const normalized = String(value || "UNKNOWN");
  return '<span class="status-chip ' + escapeHtml(kind || normalized.toLowerCase()) + '">' + escapeHtml(normalized) + '</span>';
}

function stat(label, value, meta = "") {
  return '<div class="finding-stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value ?? "—") + '</strong>' +
    (meta ? '<small>' + escapeHtml(meta) + '</small>' : "") + '</div>';
}

function percentage(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Math.round(Number(value) * 100) + "%";
}

function score(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return Number(value).toFixed(1) + "/100";
}

function authorizationSummary(center) {
  const current = center?.currentAuthorization;
  const verified = (center?.domainVerifications || []).some((item) => item.status === "VERIFIED");
  const capabilities = current?.allowed_capabilities || current?.allowedCapabilities || [];
  return {
    current,
    verified,
    remediation: Array.isArray(capabilities) && capabilities.includes("SOURCE_REMEDIATION"),
  };
}

export async function renderFindingDetailView({
  container,
  api,
  workspaceId,
  findingId,
  workspace,
  fmtDate,
  onBack,
  onOpenAuthorization,
  onRequestRepair,
}) {
  const finding = await api('/v1/platform/workspaces/' + workspaceId + '/findings/' + findingId);
  const center = await api('/v1/platform/workspaces/' + workspaceId + '/targets/' + finding.target_id + '/authorization-center')
    .catch(() => null);
  const auth = authorizationSummary(center);
  const role = workspace?.role || "VIEWER";
  const canOperate = ["OWNER", "ADMIN", "OPERATOR"].includes(role);
  const verified = finding.verification_state === "VERIFIED";
  const repairReady = verified && auth.current?.mode === "CLIENT_AUTHORIZED" && auth.remediation;
  const latestVerification = finding.verifications?.[0];

  container.innerHTML = `
    <section class="entity-header">
      <button id="finding-back" class="button subtle small" type="button">← Findings</button>
      <div class="entity-title-block">
        <div class="entity-badges">
          ${chip(finding.severity, 'severity-' + String(finding.severity || '').toLowerCase())}
          ${chip(finding.verification_state, verified ? 'verified' : 'neutral')}
          ${finding.impact_tier ? chip(finding.impact_tier, 'impact') : ''}
        </div>
        <h2>${escapeHtml(finding.title)}</h2>
        <p>${escapeHtml(finding.organization_name)} · ${escapeHtml(finding.category)} · ${escapeHtml(finding.affected_url)}</p>
      </div>
      <div class="entity-actions">
        <button id="finding-authorization" class="button subtle" type="button">Authorization</button>
        <button id="finding-repair" class="button primary" type="button" ${(!canOperate || !repairReady) ? 'disabled' : ''}>Request repair</button>
      </div>
    </section>

    <div class="finding-layout">
      <aside class="finding-context">
        <section class="panel compact-panel">
          <div class="panel-header"><h3>Finding</h3></div>
          <div class="finding-stats">
            ${stat("Status", finding.status)}
            ${stat("Confidence", percentage(finding.confidence))}
            ${stat("Occurrences", finding.occurrences)}
            ${stat("First seen", fmtDate(finding.first_seen_at))}
            ${stat("Last seen", fmtDate(finding.last_seen_at))}
            ${stat("Journey", finding.affected_journey || "—")}
          </div>
        </section>

        <section class="panel compact-panel">
          <div class="panel-header"><h3>Authorization</h3></div>
          <div class="trust-stack">
            <div><span>Domain ownership</span>${chip(auth.verified ? "VERIFIED" : "NOT VERIFIED", auth.verified ? "verified" : "warn")}</div>
            <div><span>Mode</span>${chip(auth.current?.mode || "NONE", auth.current?.mode === "CLIENT_AUTHORIZED" ? "verified" : "neutral")}</div>
            <div><span>Source remediation</span>${chip(auth.remediation ? "ALLOWED" : "NOT ALLOWED", auth.remediation ? "verified" : "warn")}</div>
          </div>
          ${!canOperate ? '<p class="permission-note">Operator role or higher is required to request repair.</p>' : ''}
          ${canOperate && !repairReady ? '<p class="permission-note">Repair remains unavailable until this finding is verified and current client authorization explicitly includes source remediation.</p>' : ''}
        </section>
      </aside>

      <main class="finding-proof">
        <section class="panel proof-panel">
          <div class="panel-header split"><div><p class="eyebrow">PROOF</p><h3>Observed evidence</h3></div><span class="status-chip neutral">Evidence first</span></div>
          ${renderEvidenceObject(finding.evidence)}
        </section>

        <section class="panel proof-panel">
          <div class="panel-header split"><div><p class="eyebrow">INDEPENDENT VERIFICATION</p><h3>Verification history</h3></div>
            ${latestVerification ? '<span class="status-chip ' + (latestVerification.status === "VERIFIED" ? "verified" : "neutral") + '">' + escapeHtml(latestVerification.status) + '</span>' : ''}
          </div>
          ${renderVerificationTimeline(finding.verifications || [], fmtDate)}
        </section>

        <section class="panel proof-panel">
          <div class="panel-header"><h3>Evidence artifacts</h3><span class="chip neutral">${finding.artifacts?.length || 0}</span></div>
          ${renderArtifacts(finding.artifacts || [], fmtDate)}
        </section>
      </main>

      <aside class="finding-decision">
        <section class="panel decision-card">
          <p class="eyebrow">DECISION</p>
          <h3>Business impact</h3>
          <div class="decision-score">${escapeHtml(score(finding.opportunity_score))}</div>
          <div class="finding-stats">
            ${stat("Impact", finding.business_impact_score ?? "—")}
            ${stat("Buyer relevance", finding.buyer_relevance ?? "—")}
            ${stat("Repair feasibility", finding.repair_feasibility ?? "—")}
            ${stat("Engineering effort", finding.engineering_effort ?? "—")}
          </div>
          ${finding.rationale ? '<div class="rationale"><strong>Why this matters</strong><p>' + escapeHtml(finding.rationale) + '</p></div>' : ''}
        </section>

        <section class="panel decision-card">
          <p class="eyebrow">NEXT SAFE ACTION</p>
          <h3>${repairReady ? "Eligible for repair approval" : "Repair gate not satisfied"}</h3>
          <p class="muted">${repairReady
            ? "Requesting repair creates a human approval. It does not execute source changes immediately."
            : "Mecord keeps source changes blocked until verification, client authorization, remediation capability and human approval all agree."}</p>
          <button id="finding-repair-secondary" class="button primary full-width" type="button" ${(!canOperate || !repairReady) ? 'disabled' : ''}>Request repair approval</button>
        </section>
      </aside>
    </div>
  `;

  container.querySelector("#finding-back")?.addEventListener("click", onBack);
  container.querySelector("#finding-authorization")?.addEventListener("click", () => onOpenAuthorization(finding.target_id));
  for (const selector of ["#finding-repair", "#finding-repair-secondary"]) {
    container.querySelector(selector)?.addEventListener("click", () => onRequestRepair(finding));
  }

  return finding;
}
