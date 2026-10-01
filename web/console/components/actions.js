import { api } from "../core/api.js";
import { state } from "../core/state.js";
import { permission, disabledAttrs } from "../core/permissions.js";
import { escapeHtml, fmtDate, safeJson } from "../core/format.js";
import { $, detail, chip, toast } from "./ui.js";
import { closeModal, confirmDecision, openModal } from "./dialog.js";

function refreshed(message = "") {
  if (message) toast(message);
  document.dispatchEvent(new CustomEvent("mecord:refresh"));
}

export function openTargetForm() {
  const access = permission("OPERATOR", { operational: true });
  openModal("Register target", "AUTHORIZED SCOPE", `
    <form id="target-form">
      <div class="form-grid">
        <label>Organization<input name="organizationName" maxlength="240" required></label>
        <label>Base URL<input name="baseUrl" type="url" placeholder="https://example.com" required></label>
        <label>Authorization mode<select name="mode"><option>PUBLIC_QA_ONLY</option><option>BUG_BOUNTY</option><option>DO_NOT_TEST</option></select></label>
        <label>Expires at<input name="expiresAt" type="datetime-local"></label>
        <label class="full">Scope notes<textarea name="scopeNotes" rows="3" maxlength="2000"></textarea></label>
        <label class="full">Evidence reference<input name="evidenceReference" maxlength="1000" placeholder="Contract, bounty program, ticket, or other authorization evidence"></label>
        <label class="full"><span>Capabilities</span><span class="filters"><input name="browser" type="checkbox" class="check-input"> Browser QA</span><small class="muted">Source remediation unlocks only after DNS ownership verification.</small></label>
      </div>
      ${access.allowed ? "" : `<p class="muted">${escapeHtml(access.reason)}</p>`}
      <div class="form-actions"><button class="button" type="button" id="target-cancel">Cancel</button><button class="button primary" type="submit" ${disabledAttrs(access)}>Register target</button></div>
    </form>`);
  $("#target-cancel").addEventListener("click", closeModal);
  $("#target-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const base = new URL(form.get("baseUrl"));
    const capabilities = ["PUBLIC_HTTP_OBSERVE"];
    if (form.get("browser")) capabilities.push("BROWSER_QA");
    await api(`/v1/platform/workspaces/${state.workspaceId}/targets`, {
      method: "POST",
      body: JSON.stringify({
        organizationName: form.get("organizationName"),
        baseUrl: base.toString(),
        authorization: {
          mode: form.get("mode"),
          allowedHosts: [base.hostname],
          allowedCapabilities: capabilities,
          scopeNotes: form.get("scopeNotes") || null,
          evidenceReference: form.get("evidenceReference") || null,
          expiresAt: form.get("expiresAt") ? new Date(form.get("expiresAt")).toISOString() : null,
        },
      }),
    });
    closeModal();
    refreshed("Target registered");
  });
}

export async function openAuthorizationCenter(targetId) {
  const center = await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${targetId}/authorization-center`);
  const current = center.currentAuthorization;
  const verified = (center.domainVerifications || []).some((item) => item.status === "VERIFIED");
  const access = permission("ADMIN", { operational: true });
  const history = (center.authorizationHistory || []).slice(0, 12);
  openModal("Authorization center", "TARGET TRUST BOUNDARY", `
    <div class="detail-grid">
      ${detail("Target", center.target.organization_name)}
      ${detail("Base URL", center.target.base_url)}
      ${detail("Current mode", current?.mode || "NONE")}
      ${detail("Ownership", verified ? "VERIFIED" : "NOT VERIFIED")}
      ${detail("Expires", current?.expires_at ? fmtDate(current.expires_at) : "No expiry")}
      ${detail("Capabilities", (current?.allowed_capabilities || current?.allowedCapabilities || []).join(", ") || "—")}
    </div>
    <h3 class="mt-16">Ownership verification</h3>
    <p class="muted">DNS proof is required before self-serve client-authorized source access.</p>
    <div class="filters"><button class="button small" id="auth-create-challenge" type="button" ${disabledAttrs(access)}>Create DNS challenge</button>${verified ? chip("VERIFIED") : chip("NOT VERIFIED")}</div>

    <h3 class="mt-16">Replace authorization</h3>
    <form id="auth-upgrade-form">
      <div class="form-grid">
        <label>Mode<select name="mode"><option>PUBLIC_QA_ONLY</option><option>BUG_BOUNTY</option><option>CLIENT_AUTHORIZED</option><option>DO_NOT_TEST</option></select></label>
        <label>Expires at<input name="expiresAt" type="datetime-local"></label>
        <label class="full">Evidence reference<input name="evidenceReference" maxlength="1000" placeholder="Contract, signed scope, program reference"></label>
        <label><span class="filters"><input name="browser" type="checkbox" class="check-input" checked> Browser QA</span></label>
        <label><span class="filters"><input name="remediation" type="checkbox" class="check-input"> Source remediation</span></label>
      </div>
      <div class="form-actions"><button class="button primary" type="submit" ${disabledAttrs(access)}>Replace authorization</button></div>
    </form>

    <h3 class="mt-16">Authorization history</h3>
    <div class="timeline">${history.map((item) => `<div class="timeline-item"><strong>${escapeHtml(item.mode || item.event_type || "Authorization")}</strong><p>${escapeHtml(fmtDate(item.created_at || item.createdAt))} · ${escapeHtml(item.revoked_at || item.revokedAt ? "revoked" : "recorded")}</p></div>`).join("") || '<div class="muted">No history yet.</div>'}</div>

    <div class="danger-zone mt-16">
      <strong>Danger zone</strong><p class="muted">Revoking authorization cancels queued/running work and clears its leases.</p>
      <button class="button danger small" id="auth-revoke" type="button" ${disabledAttrs(access)}>Revoke active authorization</button>
    </div>`);

  $("#auth-create-challenge").addEventListener("click", async () => {
    try {
      const challenge = await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${targetId}/domain-verification`, {
        method: "POST", body: "{}",
      });
      $("#modal-content").innerHTML = `
        <p class="muted">Publish this DNS TXT record, then verify after DNS propagation.</p>
        <div class="detail-grid">${detail("TXT name", challenge.dnsName)}${detail("Expires", fmtDate(challenge.expiresAt))}</div>
        <pre class="code-block">${escapeHtml(challenge.challenge)}</pre>
        <div class="form-actions"><button class="button primary" id="verify-dns-now" type="button">Verify DNS now</button></div>`;
      $("#verify-dns-now").addEventListener("click", async () => {
        try {
          await api(`/v1/platform/workspaces/${state.workspaceId}/domain-verifications/${challenge.id}/verify`, { method: "POST", body: "{}" });
          closeModal(); refreshed("Domain ownership verified");
        } catch (error) { toast(error.message, true); }
      });
    } catch (error) { toast(error.message, true); }
  });

  $("#auth-upgrade-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const base = new URL(center.target.base_url);
    const capabilities = ["PUBLIC_HTTP_OBSERVE"];
    if (form.get("browser")) capabilities.push("BROWSER_QA");
    if (form.get("remediation")) capabilities.push("SOURCE_REMEDIATION");
    await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${targetId}/authorization-center`, {
      method: "POST",
      body: JSON.stringify({
        mode: form.get("mode"),
        allowedHosts: [base.hostname],
        allowedCapabilities: capabilities,
        evidenceReference: form.get("evidenceReference") || null,
        expiresAt: form.get("expiresAt") ? new Date(form.get("expiresAt")).toISOString() : null,
      }),
    });
    closeModal(); refreshed("Authorization replaced");
  });

  $("#auth-revoke").addEventListener("click", () => confirmDecision({
    title: "Revoke target authorization",
    kicker: "HIGH-IMPACT CHANGE",
    copy: "This immediately blocks future authorized work and cancels queued/running jobs for this target.",
    confirmLabel: "Revoke authorization",
    danger: true,
    onConfirm: async () => {
      await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${targetId}/authorization/revoke`, { method: "POST", body: "{}" });
      closeModal(); refreshed("Authorization revoked");
    },
  }));
}

export function openInviteForm() {
  const access = permission("ADMIN");
  openModal("Invite member", "WORKSPACE ACCESS", `
    <form id="invite-form"><div class="form-grid">
      <label class="full">Email<input name="email" type="email" required></label>
      <label>Role<select name="role"><option>VIEWER</option><option>OPERATOR</option><option>ADMIN</option></select></label>
    </div><div class="form-actions"><button class="button" id="invite-cancel" type="button">Cancel</button><button class="button primary" type="submit" ${disabledAttrs(access)}>Create invite</button></div></form>`);
  $("#invite-cancel").addEventListener("click", closeModal);
  $("#invite-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await api(`/v1/platform/workspaces/${state.workspaceId}/invites`, {
      method: "POST", body: JSON.stringify({ email: form.get("email"), role: form.get("role") }),
    });
    $("#modal-content").innerHTML = `<p class="muted">Share this one-time token through a trusted channel. It expires automatically.</p><pre class="code-block" id="invite-token"></pre>`;
    $("#invite-token").textContent = result.inviteToken;
    $("#modal").addEventListener("close", () => refreshed(), { once: true });
    toast("Invite created");
  });
}

export function openApiKeyForm() {
  const access = permission("ADMIN");
  openModal("Create API key", "SCOPED AUTOMATION ACCESS", `
    <form id="api-key-form"><div class="form-grid">
      <label class="full">Name<input name="name" maxlength="120" required></label>
      <label>Rate limit / hour<input name="rateLimitPerHour" type="number" min="60" max="100000" value="2000"></label>
      <label>Expires at<input name="expiresAt" type="datetime-local"></label>
      <fieldset class="full fieldset-reset"><legend class="eyebrow">Scopes</legend>
        ${["workspace:read","targets:write","approvals:write","members:write","integrations:write"].map((scope, index) => `<label class="check-row"><input class="check-input" name="scope" value="${scope}" type="checkbox" ${index === 0 ? "checked" : ""}>${scope}</label>`).join("")}
      </fieldset>
    </div><div class="form-actions"><button class="button" id="key-cancel" type="button">Cancel</button><button class="button primary" type="submit" ${disabledAttrs(access)}>Create key</button></div></form>`);
  $("#key-cancel").addEventListener("click", closeModal);
  $("#api-key-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await api(`/v1/platform/workspaces/${state.workspaceId}/api-keys`, {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        scopes: form.getAll("scope"),
        rateLimitPerHour: Number(form.get("rateLimitPerHour")),
        expiresAt: form.get("expiresAt") ? new Date(form.get("expiresAt")).toISOString() : null,
      }),
    });
    $("#modal-content").innerHTML = `<p><strong>Copy this key now.</strong> It is never shown again.</p><pre class="code-block" id="new-key-secret"></pre>`;
    $("#new-key-secret").textContent = result.secret;
    toast("API key created");
    $("#modal").addEventListener("close", () => refreshed(), { once: true });
  });
}

const integrationEvents = [
  "finding.verified","approval.pending","regression.opened","remediation.succeeded",
  "revenue.received","service.renewal_due","system.test",
];

export function openIntegrationForm() {
  const access = permission("ADMIN", { operational: true });
  openModal("Add integration", "ENCRYPTED PROVIDER CONFIG", `
    <form id="integration-form">
      <div class="form-grid">
        <label>Provider<select name="provider" id="integration-provider"><option>GITHUB</option><option>SLACK</option><option>STRIPE</option><option>WEBHOOK</option></select></label>
        <label>Name<input name="name" maxlength="160" placeholder="Production notifications" required></label>
        <div id="integration-config" class="full"></div>
        <fieldset id="integration-events" class="full fieldset-reset"><legend class="eyebrow">Subscribed events</legend>
          ${integrationEvents.map((event) => `<label class="check-row compact"><input class="check-input" type="checkbox" name="event" value="${event}" ${event === "system.test" ? "" : "checked"}>${event}</label>`).join("")}
        </fieldset>
      </div>
      <p class="muted">Secrets are encrypted at rest and are never rendered again after creation.</p>
      <div class="form-actions"><button class="button" id="integration-cancel" type="button">Cancel</button><button class="button primary" type="submit" ${disabledAttrs(access)}>Create integration</button></div>
    </form>`);

  const renderConfig = () => {
    const provider = $("#integration-provider").value;
    $("#integration-events").classList.toggle("hidden", provider === "STRIPE");
    const fields = {
      GITHUB: `<div class="form-grid"><label>Token<input name="token" type="password" autocomplete="off" required></label><label>Owner<input name="owner" required></label><label>Repository<input name="repo" required></label><label>Webhook secret (optional)<input name="webhookSecret" type="password" autocomplete="off"></label></div>`,
      SLACK: `<label>Slack webhook URL<input name="webhookUrl" type="url" placeholder="https://hooks.slack.com/services/…" required></label>`,
      STRIPE: `<label>Stripe webhook secret<input name="webhookSecret" type="password" autocomplete="off" required></label>`,
      WEBHOOK: `<div class="form-grid"><label>HTTPS endpoint<input name="url" type="url" required></label><label>Signing secret<input name="signingSecret" type="password" minlength="24" autocomplete="off" required></label></div>`,
    };
    $("#integration-config").innerHTML = fields[provider];
  };
  renderConfig();
  $("#integration-provider").addEventListener("change", renderConfig);
  $("#integration-cancel").addEventListener("click", closeModal);
  $("#integration-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const provider = form.get("provider");
    const config = provider === "GITHUB"
      ? { token: form.get("token"), owner: form.get("owner"), repo: form.get("repo"), webhookSecret: form.get("webhookSecret") || null }
      : provider === "SLACK"
        ? { webhookUrl: form.get("webhookUrl") }
        : provider === "STRIPE"
          ? { webhookSecret: form.get("webhookSecret") }
          : { url: form.get("url"), signingSecret: form.get("signingSecret") };
    await api(`/v1/platform/workspaces/${state.workspaceId}/integrations`, {
      method: "POST",
      body: JSON.stringify({
        provider,
        name: form.get("name"),
        config,
        subscribedEvents: provider === "STRIPE" ? [] : form.getAll("event"),
      }),
    });
    closeModal(); refreshed("Integration created");
  });
}

export function openMonitorForm(target) {
  const access = permission("OPERATOR", { operational: true });
  openModal("Create monitor", "CONTINUOUS QA", `
    <form id="monitor-form"><div class="form-grid">
      <label>Name<input name="name" maxlength="160" value="Continuous QA" required></label>
      <label>Capability<select name="capability"><option>PUBLIC_HTTP_OBSERVE</option><option>BROWSER_QA</option></select></label>
      <label>Cadence (minutes)<input name="cadenceMinutes" type="number" min="5" max="10080" value="60" required></label>
      <label>Daily budget units<input name="dailyBudgetUnits" type="number" min=".25" max="100000" step=".25" value="100" required></label>
      <label class="full">Requested URL<input name="requestedUrl" type="url" value="${escapeHtml(target.baseUrl)}" required></label>
    </div><div class="form-actions"><button class="button" id="monitor-cancel" type="button">Cancel</button><button class="button primary" type="submit" ${disabledAttrs(access)}>Create monitor</button></div></form>`);
  $("#monitor-cancel").addEventListener("click", closeModal);
  $("#monitor-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${target.id}/monitors`, {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        capability: form.get("capability"),
        requestedUrl: form.get("requestedUrl"),
        cadenceMinutes: Number(form.get("cadenceMinutes")),
        dailyBudgetUnits: Number(form.get("dailyBudgetUnits")),
      }),
    });
    closeModal(); refreshed("Monitor created");
  });
}

export function openRepairRequest(finding) {
  const access = permission("OPERATOR", { operational: true });
  openModal("Request source repair", "HUMAN APPROVAL REQUIRED", `
    <div class="risk-summary"><strong>This does not start source changes.</strong><div>A human approval request is created first. Current authorization is rechecked again before execution.</div></div>
    <form id="repair-request-form" class="mt-12">
      <label>Authorized project root<input name="projectRoot" placeholder="C:\\path\\to\\authorized-project" required></label>
      <label class="mt-10">Approval expiry (minutes)<input name="expiresMinutes" type="number" min="5" max="1440" value="120"></label>
      <div class="form-actions"><button class="button" id="repair-cancel" type="button">Cancel</button><button class="button primary" type="submit" ${disabledAttrs(access)}>Request approval</button></div>
    </form>`);
  $("#repair-cancel").addEventListener("click", closeModal);
  $("#repair-request-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await api(`/v1/platform/workspaces/${state.workspaceId}/findings/${finding.id}/remediate`, {
      method: "POST",
      body: JSON.stringify({ projectRoot: form.get("projectRoot"), expiresMinutes: Number(form.get("expiresMinutes")) }),
    });
    closeModal(); refreshed("Repair approval requested");
  });
}

export async function decideApproval(approval, decision) {
  const access = permission("ADMIN", { operational: true });
  if (!access.allowed) return toast(access.reason, true);
  const approve = decision === "approve";
  await confirmDecision({
    title: approve ? "Approve requested action" : "Reject requested action",
    kicker: approval.action_type,
    copy: approve
      ? `Approve ${approval.action_type} for ${approval.organization_name}. The backend will re-check authorization and scope before execution.`
      : `Reject ${approval.action_type} for ${approval.organization_name}. No gated action will execute from this request.`,
    confirmLabel: approve ? "Approve action" : "Reject action",
    danger: !approve,
    onConfirm: async () => {
      await api(`/v1/platform/workspaces/${state.workspaceId}/approvals/${approval.id}/${decision}`, {
        method: "POST", body: JSON.stringify({ decisionNote: "" }),
      });
      refreshed(approve ? "Action approved" : "Action rejected");
    },
  });
}

export async function toggleIntegration(connection, enabled) {
  const access = permission("ADMIN", { operational: true });
  if (!access.allowed) return toast(access.reason, true);
  await api(`/v1/platform/workspaces/${state.workspaceId}/integrations/${connection.id}/${enabled ? "enable" : "disable"}`, { method: "POST", body: "{}" });
  refreshed(enabled ? "Integration enabled" : "Integration disabled");
}

export async function testIntegration(connection) {
  await api(`/v1/platform/workspaces/${state.workspaceId}/integrations/${connection.id}/test`, { method: "POST", body: "{}" });
  refreshed("Integration test queued");
}

export async function toggleMonitor(monitor, enabled) {
  const access = permission("OPERATOR", { operational: true });
  if (!access.allowed) return toast(access.reason, true);
  await api(`/v1/platform/workspaces/${state.workspaceId}/monitors/${monitor.id}/${enabled ? "enable" : "disable"}`, { method: "POST", body: "{}" });
  refreshed(enabled ? "Monitor enabled" : "Monitor disabled");
}

export async function runAssessment(targetId) {
  await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${targetId}/assess`, { method: "POST", body: "{}" });
  refreshed("Assessment queued");
}

export async function createReport(targetId) {
  await api(`/v1/platform/workspaces/${state.workspaceId}/reports`, { method: "POST", body: JSON.stringify({ targetId }) });
  refreshed("Report generated as READY");
}

export async function requestReportRelease(reportId) {
  await api(`/v1/platform/workspaces/${state.workspaceId}/reports/${reportId}/request-release`, { method: "POST", body: "{}" });
  refreshed("Report release approval requested");
}

export async function shareReport(reportId) {
  const result = await api(`/v1/platform/workspaces/${state.workspaceId}/reports/${reportId}/share`, {
    method: "POST", body: JSON.stringify({ expiresHours: 72 }),
  });
  openModal("Secure report share", "EXPIRES AUTOMATICALLY", `<p class="muted">Share only with the intended recipient.</p><pre class="code-block">${escapeHtml(result.url || result.token)}</pre>`);
}

export async function openBilling(plan) {
  const result = await api(`/v1/platform/workspaces/${state.workspaceId}/billing/checkout`, {
    method: "POST", body: JSON.stringify({ plan }),
  });
  location.assign(result.url);
}

export async function openBillingPortal() {
  const result = await api(`/v1/platform/workspaces/${state.workspaceId}/billing/portal`, { method: "POST", body: "{}" });
  location.assign(result.url);
}

export async function revokeApiKey(id) {
  await confirmDecision({
    title: "Revoke API key",
    copy: "Any automation using this key will immediately lose access.",
    confirmLabel: "Revoke key",
    danger: true,
    onConfirm: async () => {
      await api(`/v1/platform/workspaces/${state.workspaceId}/api-keys/${id}/revoke`, { method: "POST", body: "{}" });
      refreshed("API key revoked");
    },
  });
}

export function inspectRaw(title, value) {
  openModal(title, "TECHNICAL DETAIL", `<pre class="code-block">${escapeHtml(safeJson(value))}</pre>`);
}
