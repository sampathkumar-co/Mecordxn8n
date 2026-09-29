import { escapeHtml } from "../components/evidence.js";

const MANAGED_CAPABILITIES = [
  ["PUBLIC_HTTP_OBSERVE", "HTTP observe", "Read-only status, headers, and response observations."],
  ["BROWSER_QA", "Browser QA", "Read-only browser journey and rendering checks."],
  ["SITE_DISCOVERY", "Site discovery", "Bounded discovery inside the authorized host."],
  ["JOURNEY_QA", "Journey QA", "Authorized interaction-path quality checks."],
  ["FINDING_VERIFY", "Finding verification", "Independent reproduction and verification."],
  ["PERFORMANCE_AUDIT", "Performance audit", "Performance observations and regressions."],
  ["ACCESSIBILITY_AUDIT", "Accessibility audit", "Accessibility quality checks."],
  ["SOURCE_REMEDIATION", "Source remediation", "Human-approved source repair through Mecord Connect."],
];
const MANAGED_NAMES = new Set(MANAGED_CAPABILITIES.map(([name]) => name));

function chip(value, kind = "") {
  const text = String(value || "UNKNOWN");
  const resolved = kind || (/VERIFIED|CLIENT_AUTHORIZED|ACTIVE|ALLOWED/.test(text)
    ? "verified"
    : /EXPIRED|REVOKED|DO_NOT_TEST|FAILED/.test(text)
      ? "severity-high"
      : "neutral");
  return '<span class="status-chip ' + resolved + '">' + escapeHtml(text) + '</span>';
}

function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function capabilityRows(currentCapabilities) {
  const current = new Set(currentCapabilities || []);
  return MANAGED_CAPABILITIES.map(([name, label, description]) => `
    <label class="capability-row">
      <input type="checkbox" name="capability" value="${escapeHtml(name)}" ${current.has(name) ? "checked" : ""}>
      <span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(description)}</small></span>
    </label>
  `).join("");
}

function authorizationTimeline(history, fmtDate) {
  if (!history?.length) return '<div class="empty">No authorization history.</div>';
  return '<ol class="trust-timeline">' + history.map((item) => `
    <li>
      <span class="trust-line-dot ${item.revoked_at ? "revoked" : "active"}"></span>
      <div class="trust-event">
        <div><strong>${escapeHtml(item.mode)}</strong>${item.revoked_at ? chip("REVOKED", "severity-high") : chip("CURRENT", "verified")}</div>
        <small>Granted ${escapeHtml(fmtDate(item.created_at))}${item.revoked_at ? " · revoked " + escapeHtml(fmtDate(item.revoked_at)) : ""}</small>
        <div class="capability-tags">${(item.allowed_capabilities || []).map((cap) => '<span>' + escapeHtml(cap) + '</span>').join("") || '<span>NO CAPABILITIES</span>'}</div>
      </div>
    </li>
  `).join("") + '</ol>';
}

function verificationTimeline(items, fmtDate) {
  if (!items?.length) return '<div class="empty">No ownership checks yet.</div>';
  return '<ol class="trust-timeline">' + items.map((item) => `
    <li>
      <span class="trust-line-dot ${item.status === "VERIFIED" ? "active" : item.status === "FAILED" ? "revoked" : ""}"></span>
      <div class="trust-event">
        <div><strong>${escapeHtml(item.status)}</strong><span class="muted">${escapeHtml(item.method)}</span></div>
        <small>${escapeHtml(item.hostname)} · ${escapeHtml(fmtDate(item.created_at))}</small>
        ${item.last_error_code ? '<div class="trust-error">' + escapeHtml(item.last_error_code) + '</div>' : ''}
      </div>
    </li>
  `).join("") + '</ol>';
}

export async function renderTargetDetailView({
  container,
  api,
  workspaceId,
  targetId,
  workspace,
  fmtDate,
  navigate,
  toast,
}) {
  const [centerResult, findingsResult, operationsResult, targetsResult] = await Promise.allSettled([
    api('/v1/platform/workspaces/' + workspaceId + '/targets/' + targetId + '/authorization-center'),
    api('/v1/platform/workspaces/' + workspaceId + '/findings?limit=200'),
    api('/v1/platform/workspaces/' + workspaceId + '/operations?limit=200'),
    api('/v1/platform/workspaces/' + workspaceId + '/targets'),
  ]);

  if (centerResult.status === "rejected") throw centerResult.reason;

  const center = centerResult.value;
  const target = center.target;
  const current = center.currentAuthorization;
  const role = workspace?.role || "VIEWER";
  const canAdmin = ["OWNER", "ADMIN"].includes(role);
  const canOperate = ["OWNER", "ADMIN", "OPERATOR"].includes(role);
  const verified = (center.domainVerifications || []).some((item) => item.status === "VERIFIED");
  const targetSummary = targetsResult.status === "fulfilled"
    ? (targetsResult.value.targets || []).find((item) => item.id === targetId)
    : null;
  const findings = findingsResult.status === "fulfilled"
    ? (findingsResult.value.findings || []).filter((item) => item.targetId === targetId)
    : [];
  const operations = operationsResult.status === "fulfilled" ? operationsResult.value : null;
  const jobs = (operations?.jobs || []).filter((item) => item.target_id === targetId);
  const monitors = (operations?.monitors || []).filter((item) => item.target_id === targetId);
  const regressions = (operations?.regressions || []).filter((item) => item.target_id === targetId);
  const latestJob = jobs[0] || null;
  const currentCapabilities = current?.allowed_capabilities || [];
  const unmanaged = currentCapabilities.filter((name) => !MANAGED_NAMES.has(name));
  const sourceAllowed = currentCapabilities.includes("SOURCE_REMEDIATION");

  container.innerHTML = `
    <section class="entity-header target-header">
      <button id="target-back" class="button subtle small" type="button">← Targets</button>
      <div class="entity-title-block">
        <div class="entity-badges">
          ${chip(current?.mode || "NO AUTHORIZATION")}
          ${chip(verified ? "OWNERSHIP VERIFIED" : "OWNERSHIP NOT VERIFIED", verified ? "verified" : "warn")}
          ${sourceAllowed ? chip("SOURCE REPAIR ALLOWED", "verified") : ""}
        </div>
        <h2>${escapeHtml(target.organization_name)}</h2>
        <p>${escapeHtml(target.base_url)}</p>
      </div>
      <div class="entity-actions">
        <button id="target-assess" class="button primary" type="button" ${(!canOperate || current?.mode === "DO_NOT_TEST" || !current) ? "disabled" : ""}>Run assessment</button>
      </div>
    </section>

    ${[findingsResult, operationsResult, targetsResult].some((item) => item.status === "rejected")
      ? '<div class="partial-banner"><strong>Partial target data</strong><span>Authorization is current; one or more operational summaries could not be loaded.</span></div>'
      : ''}

    <div class="target-layout">
      <main class="target-main">
        <section class="grid metrics target-metrics">
          <div class="metric"><div class="eyebrow">Findings</div><div class="value">${escapeHtml(targetSummary?.findingCount ?? findings.length)}</div><div class="meta"><span>${findings.filter((item) => item.verificationState === "VERIFIED").length} verified</span></div></div>
          <div class="metric"><div class="eyebrow">Monitors</div><div class="value">${escapeHtml(targetSummary?.monitorCount ?? monitors.length)}</div><div class="meta"><span>${monitors.filter((item) => item.enabled).length} active</span></div></div>
          <div class="metric"><div class="eyebrow">Open regressions</div><div class="value">${escapeHtml(regressions.filter((item) => item.status === "OPEN").length)}</div><div class="meta"><span>Continuous monitoring</span></div></div>
          <div class="metric"><div class="eyebrow">Latest run</div><div class="value target-run-state">${escapeHtml(latestJob?.state || "—")}</div><div class="meta"><span>${escapeHtml(latestJob ? fmtDate(latestJob.created_at) : "No run yet")}</span></div></div>
        </section>

        <section class="panel target-findings">
          <div class="panel-header split"><div><p class="eyebrow">PROBLEM → PROOF</p><h3>Recent findings</h3></div><button id="target-all-findings" class="button text small" type="button">All findings →</button></div>
          ${findings.length ? '<div class="target-finding-list">' + findings.slice(0, 10).map((item) => `
            <button class="target-finding-row" type="button" data-finding-id="${escapeHtml(item.id)}">
              ${chip(item.severity, item.severity === "HIGH" ? "severity-high" : item.severity === "MEDIUM" ? "warn" : "neutral")}
              <span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.category)} · ${escapeHtml(item.affectedUrl)}</small></span>
              ${chip(item.verificationState, item.verificationState === "VERIFIED" ? "verified" : "neutral")}
              <span aria-hidden="true">→</span>
            </button>
          `).join("") + '</div>' : '<div class="empty"><strong>No findings yet</strong>Run an authorized assessment to begin collecting evidence.</div>'}
        </section>

        <section class="panel">
          <div class="panel-header split"><div><p class="eyebrow">TRUST HISTORY</p><h3>Authorization timeline</h3></div><span class="chip neutral">${center.authorizationHistory?.length || 0}</span></div>
          ${authorizationTimeline(center.authorizationHistory, fmtDate)}
        </section>
      </main>

      <aside class="target-side">
        <section class="panel decision-card">
          <p class="eyebrow">CURRENT AUTHORIZATION</p>
          <h3>${escapeHtml(current?.mode || "No active authorization")}</h3>
          <div class="trust-stack">
            <div><span>Ownership</span>${chip(verified ? "VERIFIED" : "NOT VERIFIED", verified ? "verified" : "warn")}</div>
            <div><span>Expires</span>${chip(current?.expires_at ? fmtDate(current.expires_at) : "NO EXPIRY", current?.expires_at && new Date(current.expires_at).getTime() <= Date.now() ? "severity-high" : "neutral")}</div>
            <div><span>Source remediation</span>${chip(sourceAllowed ? "ALLOWED" : "NOT ALLOWED", sourceAllowed ? "verified" : "warn")}</div>
          </div>
          <div class="capability-tags target-capability-tags">${currentCapabilities.map((cap) => '<span>' + escapeHtml(cap) + '</span>').join("") || '<span>NO CAPABILITIES</span>'}</div>
        </section>

        <section class="panel decision-card">
          <div class="panel-header"><h3>Domain ownership</h3></div>
          <p class="muted">DNS proof is required before self-serve client-authorized source remediation can be granted.</p>
          <button id="target-create-dns" class="button subtle full-width" type="button" ${!canAdmin ? "disabled" : ""}>Create DNS challenge</button>
          <div id="target-dns-challenge" class="dns-challenge-area"></div>
          <div class="trust-history-compact">${verificationTimeline(center.domainVerifications, fmtDate)}</div>
          ${!canAdmin ? '<p class="permission-note">Workspace ADMIN or OWNER is required for ownership verification.</p>' : ''}
        </section>

        <section class="panel decision-card">
          <div class="panel-header"><h3>Replace authorization</h3></div>
          <form id="target-auth-form">
            <label>Mode
              <select name="mode" ${!canAdmin ? "disabled" : ""}>
                ${["PUBLIC_QA_ONLY","BUG_BOUNTY","CLIENT_AUTHORIZED","DO_NOT_TEST"].map((mode) => '<option value="' + mode + '"' + (mode === current?.mode ? ' selected' : '') + '>' + mode + '</option>').join("")}
              </select>
            </label>
            <label>Expires at
              <input name="expiresAt" type="datetime-local" value="${escapeHtml(toLocalInput(current?.expires_at))}" ${!canAdmin ? "disabled" : ""}>
            </label>
            <label>Evidence reference
              <input name="evidenceReference" maxlength="1000" value="${escapeHtml(current?.evidence_reference || "")}" placeholder="Contract, scope document, bounty reference" ${!canAdmin ? "disabled" : ""}>
            </label>
            <label>Scope notes
              <textarea name="scopeNotes" rows="3" maxlength="2000" ${!canAdmin ? "disabled" : ""}>${escapeHtml(current?.scope_notes || "")}</textarea>
            </label>
            <div class="capability-picker">
              <span class="eyebrow">Capabilities</span>
              ${capabilityRows(currentCapabilities)}
            </div>
            ${unmanaged.length ? '<div class="server-capabilities"><strong>Server-managed capabilities preserved</strong><span>' + unmanaged.map(escapeHtml).join(", ") + '</span></div>' : ''}
            <div class="decision-buttons target-auth-actions">
              <button id="target-revoke-start" class="button danger" type="button" ${(!canAdmin || !current) ? "disabled" : ""}>Revoke</button>
              <button class="button primary" type="submit" ${!canAdmin ? "disabled" : ""}>Replace authorization</button>
            </div>
            <div id="target-revoke-confirm" class="revoke-confirm hidden">
              <strong>Revoke current authorization?</strong>
              <span>Queued/running target jobs are cancelled and their leases are cleared.</span>
              <div class="filters"><button id="target-revoke-cancel" class="button small" type="button">Cancel</button><button id="target-revoke-confirm-button" class="button small danger" type="button">Confirm revoke</button></div>
            </div>
          </form>
          ${!canAdmin ? '<p class="permission-note">Workspace ADMIN or OWNER is required to replace or revoke authorization.</p>' : ''}
        </section>
      </aside>
    </div>
  `;

  const rerender = () => renderTargetDetailView({
    container,
    api,
    workspaceId,
    targetId,
    workspace,
    fmtDate,
    navigate,
    toast,
  });

  container.querySelector("#target-back")?.addEventListener("click", () => navigate("/console/targets"));
  container.querySelector("#target-all-findings")?.addEventListener("click", () => navigate("/console/findings"));
  container.querySelectorAll("[data-finding-id]").forEach((button) => {
    button.addEventListener("click", () => navigate('/console/findings/' + button.dataset.findingId));
  });

  container.querySelector("#target-assess")?.addEventListener("click", async () => {
    const button = container.querySelector("#target-assess");
    button.disabled = true;
    try {
      await api('/v1/platform/workspaces/' + workspaceId + '/targets/' + targetId + '/assess', {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast("Assessment queued");
      await rerender();
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  });

  container.querySelector("#target-create-dns")?.addEventListener("click", async () => {
    const button = container.querySelector("#target-create-dns");
    button.disabled = true;
    try {
      const challenge = await api('/v1/platform/workspaces/' + workspaceId + '/targets/' + targetId + '/domain-verification', {
        method: "POST",
        body: JSON.stringify({}),
      });
      const area = container.querySelector("#target-dns-challenge");
      area.innerHTML = `
        <div class="dns-challenge">
          <span class="eyebrow">DNS TXT RECORD</span>
          <div><small>Name</small><code>${escapeHtml(challenge.dnsName)}</code></div>
          <div><small>Value</small><code>${escapeHtml(challenge.challenge)}</code></div>
          <div><small>Expires</small><strong>${escapeHtml(fmtDate(challenge.expiresAt))}</strong></div>
          <button id="target-verify-dns" class="button primary small" type="button">Verify DNS now</button>
        </div>
      `;
      area.querySelector("#target-verify-dns")?.addEventListener("click", async (event) => {
        event.currentTarget.disabled = true;
        try {
          await api('/v1/platform/workspaces/' + workspaceId + '/domain-verifications/' + challenge.id + '/verify', {
            method: "POST",
            body: JSON.stringify({}),
          });
          toast("Domain ownership verified");
          await rerender();
        } catch (error) {
          event.currentTarget.disabled = false;
          toast(error.message, true);
        }
      });
    } catch (error) {
      button.disabled = false;
      toast(error.message, true);
    }
  });

  container.querySelector("#target-auth-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const mode = String(form.get("mode") || "");
    const capabilities = form.getAll("capability").map(String);
    for (const capability of unmanaged) {
      if (!capabilities.includes(capability)) capabilities.push(capability);
    }
    if (mode === "DO_NOT_TEST") capabilities.length = 0;
    if (capabilities.includes("SOURCE_REMEDIATION") && mode !== "CLIENT_AUTHORIZED") {
      toast("Source remediation requires CLIENT_AUTHORIZED mode", true);
      return;
    }
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const base = new URL(target.base_url);
      await api('/v1/platform/workspaces/' + workspaceId + '/targets/' + targetId + '/authorization-center', {
        method: "POST",
        body: JSON.stringify({
          mode,
          allowedHosts: current?.allowed_hosts?.length ? current.allowed_hosts : [base.hostname],
          allowedCapabilities: capabilities,
          scopeNotes: form.get("scopeNotes") || null,
          evidenceReference: form.get("evidenceReference") || null,
          expiresAt: form.get("expiresAt") ? new Date(form.get("expiresAt")).toISOString() : null,
        }),
      });
      toast("Authorization replaced");
      await rerender();
    } catch (error) {
      submit.disabled = false;
      toast(error.message, true);
    }
  });

  const revokeConfirm = container.querySelector("#target-revoke-confirm");
  container.querySelector("#target-revoke-start")?.addEventListener("click", () => revokeConfirm?.classList.remove("hidden"));
  container.querySelector("#target-revoke-cancel")?.addEventListener("click", () => revokeConfirm?.classList.add("hidden"));
  container.querySelector("#target-revoke-confirm-button")?.addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    try {
      await api('/v1/platform/workspaces/' + workspaceId + '/targets/' + targetId + '/authorization/revoke', {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast("Authorization revoked");
      await rerender();
    } catch (error) {
      event.currentTarget.disabled = false;
      toast(error.message, true);
    }
  });
}
