import {
  findingPath,
  navigateConsole,
  parseConsoleRoute,
  pathForView,
} from "/console/core/router.js";
import { renderFindingDetailView } from "/console/views/finding-detail.js";
import { renderHomeView } from "/console/views/home.js";

const state = {
  token: sessionStorage.getItem("mecord_session") || "",
  me: null,
  workspaceId: sessionStorage.getItem("mecord_workspace") || "",
  view: "overview",
  params: {},
};

const $ = (selector) => document.querySelector(selector);
const authView = $("#auth-view");
const appView = $("#app-view");
const content = $("#content");
const modal = $("#modal");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function fmtMoney(minor, currency) {
  if (minor == null || !currency) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(Number(minor) / 100);
  } catch {
    return `${currency} ${(Number(minor) / 100).toFixed(2)}`;
  }
}

let toastTimer;

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

function setConnectionState(stateName) {
  const badge = $("#connection-badge");
  if (!badge) return;
  badge.className = "status-pill";
  if (stateName === "offline") {
    badge.classList.add("danger");
    badge.textContent = "Control API unreachable";
  } else if (stateName === "degraded") {
    badge.classList.add("warn");
    badge.textContent = "Control API degraded";
  } else {
    badge.classList.add("good");
    badge.textContent = "Control API online";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const retryable = method === "GET" || method === "HEAD";
  const attempts = retryable ? 2 : 1;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
    if (options.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers,
        signal: options.signal || AbortSignal.timeout(15_000),
      });
    } catch (error) {
      setConnectionState("offline");
      if (retryable && attempt + 1 < attempts) {
        await sleep(200 + attempt * 250);
        continue;
      }
      const timeout = error?.name === "TimeoutError";
      const wrapped = new Error(
        timeout
          ? "The Control API did not respond in time."
          : "Could not reach the Control API.",
      );
      wrapped.code = timeout ? "REQUEST_TIMEOUT" : "NETWORK_ERROR";
      throw wrapped;
    }

    if ([429, 502, 503, 504].includes(response.status) && retryable && attempt + 1 < attempts) {
      setConnectionState("degraded");
      await sleep(250 + attempt * 300);
      continue;
    }

    setConnectionState(response.status >= 500 ? "degraded" : "online");
    const payload = response.status === 204
      ? null
      : await response.json().catch(() => ({ error: "INVALID_RESPONSE" }));

    if (response.status === 401 && !path.includes("/auth/login")) {
      signOut(false);
      throw new Error("Your session has expired.");
    }
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.error || "Request failed");
      error.code = payload?.error;
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  throw new Error("Request failed");
}

function loading() {
  content.innerHTML = `<div class="grid metrics">
    <div class="skeleton"></div><div class="skeleton"></div>
    <div class="skeleton"></div><div class="skeleton"></div>
  </div><div class="panel" style="margin-top:14px"><div class="skeleton"></div></div>`;
}

function showAuth() {
  authView.classList.remove("hidden");
  appView.classList.add("hidden");
}

function showApp() {
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
}

function applyRoute(route) {
  state.view = route.view;
  state.params = route.params || {};
}

async function boot() {
  if (!state.token) return showAuth();
  try {
    state.me = await api("/v1/platform/me");
    const workspaces = state.me.workspaces || [];
    if (!workspaces.length) throw new Error("No workspace membership found.");
    if (!workspaces.some((item) => item.id === state.workspaceId)) {
      state.workspaceId = workspaces[0].id;
      sessionStorage.setItem("mecord_workspace", state.workspaceId);
    }
    const route = parseConsoleRoute();
    applyRoute(route);
    if (route.notFound || window.location.pathname === "/console" || window.location.pathname === "/console/") {
      window.history.replaceState({}, "", route.path);
    }
    hydrateShell();
    showApp();
    await render();
  } catch (error) {
    toast(error.message, true);
    showAuth();
  }
}

function hydrateShell() {
  const select = $("#workspace-select");
  select.innerHTML = state.me.workspaces
    .map((workspace) =>
      `<option value="${escapeHtml(workspace.id)}"${workspace.id === state.workspaceId ? " selected" : ""}>
        ${escapeHtml(workspace.name)} · ${escapeHtml(workspace.role || workspace.plan || "")}
      </option>`,
    )
    .join("");
  $("#user-chip").innerHTML = state.me.principal.user
    ? `<strong>${escapeHtml(state.me.principal.user.displayName)}</strong><span>${escapeHtml(state.me.principal.user.email)}</span>`
    : `<strong>API key</strong><span>Workspace-scoped access</span>`;
  $("#operator-nav").classList.toggle(
    "hidden",
    !state.me.principal.user?.isPlatformOperator,
  );
}

function currentWorkspace() {
  return state.me?.workspaces?.find((item) => item.id === state.workspaceId);
}

const viewMeta = {
  overview: ["WORKSPACE", "Home", "Add target"],
  launch: ["GO LIVE", "Launch", "Refresh"],
  targets: ["ASSETS", "Targets", "Add target"],
  findings: ["EVIDENCE", "Findings", "Refresh"],
  findingDetail: ["ENGINEERING", "Finding", "Refresh"],
  approvals: ["HUMAN GATES", "Approvals", "Refresh"],
  pipeline: ["COMMERCIAL", "Pipeline", "Refresh"],
  operations: ["RUNTIME", "Operations", "Refresh"],
  integrations: ["CONNECTIONS", "Integrations", "Add integration"],
  team: ["ACCESS", "Team & Access", "Invite member"],
  audit: ["GOVERNANCE", "Audit", "Refresh"],
  operator: ["PLATFORM", "Operator", "Refresh"],
};

const breadcrumbForView = {
  overview: "Workspace / Home",
  launch: "Workspace / Launch",
  targets: "Workspace / Engineering / Targets",
  findings: "Workspace / Engineering / Findings",
  findingDetail: "Workspace / Engineering / Findings / Detail",
  operations: "Workspace / Engineering / Runs",
  approvals: "Workspace / Repair / Approval inbox",
  pipeline: "Workspace / Revenue / Opportunities",
  integrations: "Workspace / Integrations",
  team: "Workspace / Team & Access",
  audit: "Workspace / Audit",
  operator: "Platform / Operator",
};

async function render() {
  const [kicker, title, action] = viewMeta[state.view] || viewMeta.overview;
  $("#view-kicker").textContent = kicker;
  $("#view-title").textContent = title;
  $("#breadcrumb").textContent = breadcrumbForView[state.view] || "Workspace";
  $("#primary-action").textContent = action;
  const activeView = state.view === "findingDetail" ? "findings" : state.view;
  document.querySelectorAll(".nav-item").forEach((node) => {
    node.classList.toggle("active", node.dataset.view === activeView);
  });
  loading();
  try {
    const renderer = {
      overview: renderOverview,
      launch: renderLaunch,
      targets: renderTargets,
      findings: renderFindings,
      findingDetail: renderFindingDetail,
      approvals: renderApprovals,
      pipeline: renderPipeline,
      operations: renderOperations,
      integrations: renderIntegrations,
      team: renderTeam,
      audit: renderAudit,
      operator: renderOperator,
    }[state.view];
    await renderer();
    content.focus();
  } catch (error) {
    content.innerHTML = `<div class="panel"><div class="empty">
      <strong>Could not load this view</strong>
      <span>${escapeHtml(error.message)}</span>
      <button id="retry-view" class="button primary small" type="button">Retry</button>
    </div></div>`;
    $("#retry-view")?.addEventListener("click", () => render());
    toast(error.message, true);
  }
}

async function renderOverview() {
  await renderHomeView({
    container: content,
    api,
    workspaceId: state.workspaceId,
    fmtDate,
    fmtMoney,
    navigate: (path) => navigateConsole(path),
  });
}

function metric(label, value, meta) {
  return `<div class="metric"><div class="eyebrow">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="meta"><span>${escapeHtml(meta)}</span></div></div>`;
}

function detail(label, value) {
  return `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "—")}</strong></div>`;
}

function chip(value) {
  const text = String(value || "—");
  const danger = /DEAD|FAILED|REJECTED|EXPIRED|BLOCKED|HIGH|SUSPENDED/i.test(text);
  const good = /ACTIVE|APPROVED|SUCCEEDED|VERIFIED|HEALTHY|WON/i.test(text);
  return `<span class="chip ${danger ? "danger" : good ? "good" : "neutral"}">${escapeHtml(text)}</span>`;
}

async function renderTargets() {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/targets`);
  content.innerHTML = tablePanel(
    "Authorized targets",
    ["Organization", "Base URL", "Authorization", "Findings", "Monitors", "Created"],
    data.targets.map((item) => [
      `<button class="button text target-open" data-id="${escapeHtml(item.id)}"><span class="primary-text">${escapeHtml(item.organizationName)}</span></button>`,
      `<div class="secondary-text">${escapeHtml(item.baseUrl)}</div>`,
      chip(item.authorizationMode),
      escapeHtml(item.findingCount),
      escapeHtml(item.monitorCount),
      escapeHtml(fmtDate(item.createdAt)),
    ]),
    "No targets yet",
    "Register the first authorized website or service boundary.",
  );
  document.querySelectorAll(".target-open").forEach((button) => {
    button.addEventListener("click", () => openAuthorizationCenter(button.dataset.id));
  });
}

async function renderLaunch() {
  const [onboarding, health, subscription, targets] = await Promise.all([
    api(`/v1/platform/workspaces/${state.workspaceId}/onboarding`),
    api(`/v1/platform/workspaces/${state.workspaceId}/health`),
    api(`/v1/platform/workspaces/${state.workspaceId}/subscription`),
    api(`/v1/platform/workspaces/${state.workspaceId}/targets`),
  ]);
  const target = targets.targets?.[0] || null;
  const checks = onboarding.checklist || {};
  const step = (label, done, copy, action = "") => `
    <div class="launch-step">
      <span class="launch-check ${done ? "done" : ""}">${done ? "✓" : "•"}</span>
      <div><strong>${escapeHtml(label)}</strong><div class="secondary-text">${escapeHtml(copy)}</div></div>
      <div>${action}</div>
    </div>`;
  const targetAction = target
    ? `<button class="button small auth-center" data-id="${escapeHtml(target.id)}">Manage authorization</button>`
    : `<button class="button small primary" id="launch-add-target">Add target</button>`;
  const assessAction = target && !checks.assessmentStarted
    ? `<button class="button small primary" id="launch-assess">Run assessment</button>`
    : "";
  const reportActions = onboarding.firstReportId
    ? `<div class="filters">
         <button class="button small" id="launch-request-release">Request release</button>
         <button class="button small primary" id="launch-share-report">Create secure share</button>
       </div>`
    : "";
  content.innerHTML = `
    <div class="grid metrics">
      ${metric("Launch status", onboarding.status, checks.reportReady ? "First report ready" : "Complete onboarding")}
      ${metric("Service health", health.status, (health.issues || []).join(", ") || "No active issues")}
      ${metric("Plan", subscription.subscription?.plan || subscription.workspace?.plan || "—", subscription.subscription?.status || "—")}
      ${metric("Trial ends", fmtDate(subscription.subscription?.trial_ends_at), "Upgrade anytime")}
    </div>
    <div class="split">
      <section class="panel">
        <div class="panel-header"><h2>First-value checklist</h2><span class="chip ${onboarding.status === "READY" ? "good" : "neutral"}">${escapeHtml(onboarding.status)}</span></div>
        <div class="panel-body launch-list">
          ${step("Account created", checks.accountCreated, "Workspace and owner session are active.")}
          ${step("Register target", checks.targetRegistered, "Start with non-destructive public QA.", targetAction)}
          ${step("Verify ownership", checks.ownershipVerified, "DNS ownership is required before client-authorized source access.", target ? `<button class="button small auth-center" data-id="${escapeHtml(target.id)}">Verify / manage</button>` : "")}
          ${step("Run first assessment", checks.assessmentStarted, "Queues authorized HTTP and browser QA only.", assessAction)}
          ${step("Report ready", checks.reportReady, "Report release remains human-approved before external sharing.", reportActions)}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>Billing</h2><span class="chip neutral">Stripe</span></div>
        <div class="panel-body">
          <p class="muted">Checkout and Customer Portal open on Stripe. Card data never passes through Mecordxn8n.</p>
          <div class="filters">
            <button class="button small billing-checkout" data-plan="TEAM">Team</button>
            <button class="button small billing-checkout" data-plan="BUSINESS">Business</button>
            <button class="button small" id="billing-portal">Billing portal</button>
          </div>
        </div>
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <div class="panel-header"><h2>Operational health</h2><span class="chip ${health.status === "HEALTHY" ? "good" : "warn"}">${escapeHtml(health.status)}</span></div>
      <div class="panel-body detail-grid">
        ${detail("Pending approvals", health.pendingApprovals)}
        ${detail("Open regressions", health.openRegressions)}
        ${detail("Failing monitors", health.monitoring?.failing || 0)}
        ${detail("Integration dead letters", health.integrations24h?.DEAD_LETTER || 0)}
      </div>
    </section>`;

  $("#launch-add-target")?.addEventListener("click", openTargetForm);
  document.querySelectorAll(".auth-center").forEach((button) => {
    button.addEventListener("click", () => openAuthorizationCenter(button.dataset.id));
  });
  $("#launch-assess")?.addEventListener("click", async () => {
    try {
      await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${target.id}/assess`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast("First assessment queued");
      await renderLaunch();
    } catch (error) { toast(error.message, true); }
  });
  $("#launch-request-release")?.addEventListener("click", async () => {
    try {
      await api(`/v1/platform/workspaces/${state.workspaceId}/reports/${onboarding.firstReportId}/request-release`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast("Report release approval requested");
      state.view = "approvals";
      await render();
    } catch (error) { toast(error.message, true); }
  });
  $("#launch-share-report")?.addEventListener("click", async () => {
    try {
      const result = await api(`/v1/platform/workspaces/${state.workspaceId}/reports/${onboarding.firstReportId}/share`, {
        method: "POST",
        body: JSON.stringify({ expiresHours: 72 }),
      });
      openModal("Secure report share", "EXPIRES AUTOMATICALLY",
        `<p class="muted">Share only with the intended recipient.</p><pre class="code-block">${escapeHtml(result.url || result.token)}</pre>`);
    } catch (error) { toast(error.message, true); }
  });
  document.querySelectorAll(".billing-checkout").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        const result = await api(`/v1/platform/workspaces/${state.workspaceId}/billing/checkout`, {
          method: "POST",
          body: JSON.stringify({ plan: button.dataset.plan }),
        });
        window.location.assign(result.url);
      } catch (error) { toast(error.message, true); }
    });
  });
  $("#billing-portal")?.addEventListener("click", async () => {
    try {
      const result = await api(`/v1/platform/workspaces/${state.workspaceId}/billing/portal`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      window.location.assign(result.url);
    } catch (error) { toast(error.message, true); }
  });
}

async function openAuthorizationCenter(targetId) {
  const center = await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${targetId}/authorization-center`);
  const current = center.currentAuthorization;
  const verified = (center.domainVerifications || []).some((item) => item.status === "VERIFIED");
  openModal("Authorization center", "TARGET TRUST BOUNDARY", `
    <div class="detail-grid">
      ${detail("Target", center.target.organization_name)}
      ${detail("Base URL", center.target.base_url)}
      ${detail("Current mode", current?.mode || "NONE")}
      ${detail("Ownership", verified ? "VERIFIED" : "NOT VERIFIED")}
    </div>
    <h3>Ownership verification</h3>
    <p class="muted">Create a DNS TXT challenge, publish it, then verify. Privileged source access remains blocked until this succeeds.</p>
    <div class="filters">
      <button class="button small" id="auth-create-challenge">Create DNS challenge</button>
      ${verified ? '<span class="chip good">Verified</span>' : ""}
    </div>
    <h3>Authorization</h3>
    <form id="auth-upgrade-form">
      <div class="form-grid">
        <label>Mode<select name="mode"><option>PUBLIC_QA_ONLY</option><option>BUG_BOUNTY</option><option>CLIENT_AUTHORIZED</option><option>DO_NOT_TEST</option></select></label>
        <label>Expires at<input name="expiresAt" type="datetime-local"></label>
        <label class="full">Evidence reference<input name="evidenceReference" maxlength="1000" placeholder="Contract, signed scope, program reference"></label>
        <label><input name="browser" type="checkbox" checked> Browser QA</label>
        <label><input name="remediation" type="checkbox"> Source remediation</label>
      </div>
      <div class="form-actions">
        <button class="button danger" id="auth-revoke" type="button">Revoke access</button>
        <button class="button primary" type="submit">Replace authorization</button>
      </div>
    </form>
    <h3>History</h3>
    <pre class="code-block">${escapeHtml(JSON.stringify(center.authorizationHistory || [], null, 2))}</pre>`);

  $("#auth-create-challenge").addEventListener("click", async () => {
    try {
      const challenge = await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${targetId}/domain-verification`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      $("#modal-content").innerHTML = `
        <p class="muted">Create this DNS TXT record, wait for DNS propagation, then verify.</p>
        <div class="detail-grid">
          ${detail("TXT name", challenge.dnsName)}
          ${detail("Expires", fmtDate(challenge.expiresAt))}
        </div>
        <pre class="code-block">${escapeHtml(challenge.challenge)}</pre>
        <div class="form-actions"><button class="button primary" id="verify-dns-now">Verify DNS now</button></div>`;
      $("#verify-dns-now").addEventListener("click", async () => {
        try {
          await api(`/v1/platform/workspaces/${state.workspaceId}/domain-verifications/${challenge.id}/verify`, {
            method: "POST",
            body: JSON.stringify({}),
          });
          toast("Domain ownership verified");
          modal.close();
          await render();
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
    try {
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
      toast("Authorization replaced");
      modal.close();
      await render();
    } catch (error) { toast(error.message, true); }
  });
  $("#auth-revoke").addEventListener("click", async () => {
    try {
      await api(`/v1/platform/workspaces/${state.workspaceId}/targets/${targetId}/authorization/revoke`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      toast("Authorization revoked");
      modal.close();
      await render();
    } catch (error) { toast(error.message, true); }
  });
}

async function renderOperator() {
  const data = await api("/v1/platform/admin/overview?limit=200");
  content.innerHTML = `
    <div class="grid metrics">
      ${metric("Active workspaces", data.summary.active_workspaces, "Customer estates")}
      ${metric("Active users", data.summary.active_users, "Platform accounts")}
      ${metric("Pending approvals", data.summary.pending_approvals, "Across platform")}
      ${metric("Failed jobs 24h", data.summary.failed_jobs_24h, "Needs attention")}
    </div>
    <div class="split">
      ${tablePanel("Workspaces",["Workspace","Plan","Subscription","Targets","Members"],data.workspaces.map((item)=>[
        `<div class="primary-text">${escapeHtml(item.name)}</div><div class="secondary-text">${escapeHtml(item.slug)}</div>`,
        chip(item.plan),chip(item.subscription_status),escapeHtml(item.targets),escapeHtml(item.members)
      ]),"No workspaces","No customer workspaces yet.")}
      ${tablePanel("Fleet alerts",["Type","Workspace","Detail","Time"],data.alerts.map((item)=>[
        chip(item.kind),escapeHtml(item.workspace_id || "—"),escapeHtml(item.detail || "—"),escapeHtml(fmtDate(item.occurred_at))
      ]),"No alerts","Platform fleet is healthy.")}
    </div>`;
}

async function renderFindings() {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/findings?limit=200`);
  content.innerHTML = tablePanel(
    "Evidence-backed findings",
    ["Severity", "Finding", "Target", "Verification", "Opportunity", "Last seen"],
    data.findings.map((item) => [
      chip(item.severity),
      `<button class="button text finding-open" data-id="${escapeHtml(item.id)}"><span class="primary-text">${escapeHtml(item.title)}</span></button><div class="secondary-text">${escapeHtml(item.category)} · ${escapeHtml(item.affectedUrl)}</div>`,
      escapeHtml(item.organizationName),
      chip(item.verificationState),
      item.opportunityScore == null ? "—" : `${escapeHtml(item.opportunityScore.toFixed(1))}/100`,
      escapeHtml(fmtDate(item.lastSeenAt)),
    ]),
    "No findings",
    "Findings appear after authorized QA jobs produce evidence.",
  );
  document.querySelectorAll(".finding-open").forEach((button) => {
    button.addEventListener("click", () => navigateConsole(findingPath(button.dataset.id)));
  });
}

function openRepairRequest(finding) {
  openModal("Request repair approval", "HUMAN-GATED SOURCE REMEDIATION", `
    <div class="callout">
      <strong>No source change happens from this request.</strong>
      <p class="muted">This creates an approval request. Current authorization and finding verification are checked again before remediation can execute.</p>
    </div>
    <form id="repair-request-form">
      <div class="form-grid">
        <label class="full">Authorized project root
          <input name="projectRoot" maxlength="1000" placeholder="Authorized Mecord project root" required>
        </label>
        <label>Approval expires in
          <select name="expiresMinutes">
            <option value="60">1 hour</option>
            <option value="120" selected>2 hours</option>
            <option value="240">4 hours</option>
            <option value="1440">24 hours</option>
          </select>
        </label>
      </div>
      <div class="form-actions">
        <button id="repair-request-cancel" class="button" type="button">Cancel</button>
        <button class="button primary" type="submit">Create approval request</button>
      </div>
    </form>
  `);
  $("#repair-request-cancel")?.addEventListener("click", () => modal.close());
  $("#repair-request-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const submit = event.currentTarget.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api(`/v1/platform/workspaces/${state.workspaceId}/findings/${finding.id}/remediate`, {
        method: "POST",
        body: JSON.stringify({
          projectRoot: form.get("projectRoot"),
          expiresMinutes: Number(form.get("expiresMinutes")),
        }),
      });
      modal.close();
      toast("Repair approval requested");
      navigateConsole("/console/approvals");
    } catch (error) {
      submit.disabled = false;
      toast(error.message, true);
    }
  });
}

async function renderFindingDetail() {
  if (!state.params.findingId) {
    navigateConsole("/console/findings", { replace: true });
    return;
  }
  await renderFindingDetailView({
    container: content,
    api,
    workspaceId: state.workspaceId,
    findingId: state.params.findingId,
    workspace: currentWorkspace(),
    fmtDate,
    onBack: () => navigateConsole("/console/findings"),
    onOpenAuthorization: openAuthorizationCenter,
    onRequestRepair: openRepairRequest,
  });
}

async function renderApprovals() {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/approvals?limit=200`);
  content.innerHTML = tablePanel(
    "Approval inbox",
    ["Type", "Target", "Status", "Requested by", "Expires", "Decision"],
    data.approvals.map((item) => [
      `<span class="primary-text">${escapeHtml(item.action_type)}</span>`,
      escapeHtml(item.organization_name),
      chip(item.status),
      escapeHtml(item.requested_by),
      escapeHtml(fmtDate(item.expires_at)),
      item.status === "PENDING"
        ? `<div class="filters"><button class="button small primary approval-action" data-id="${item.id}" data-decision="approve">Approve</button> <button class="button small danger approval-action" data-id="${item.id}" data-decision="reject">Reject</button></div>`
        : escapeHtml(item.decided_by || "—"),
    ]),
    "Nothing waiting",
    "Approval-gated operations will appear here.",
  );
  document.querySelectorAll(".approval-action").forEach((button) => {
    button.addEventListener("click", async () => {
      try {
        await api(
          `/v1/platform/workspaces/${state.workspaceId}/approvals/${button.dataset.id}/${button.dataset.decision}`,
          { method: "POST", body: JSON.stringify({}) },
        );
        toast(`Approval ${button.dataset.decision}d`);
        await renderApprovals();
      } catch (error) {
        toast(error.message, true);
      }
    });
  });
}

async function renderPipeline() {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/pipeline?limit=300`);
  const groups = {
    NEW: [], QUALIFIED: [], ENGAGED: [], PROPOSAL: [],
    NEGOTIATING: [], WON: [], LOST: [], PAUSED: [],
  };
  for (const item of data.opportunities) (groups[item.state] ||= []).push(item);
  const visible = ["NEW","QUALIFIED","ENGAGED","PROPOSAL","NEGOTIATING","WON"];
  content.innerHTML = `<div class="pipeline">${visible.map((name) => `
    <section class="pipeline-col">
      <div class="pipeline-head">${escapeHtml(name)} · ${groups[name]?.length || 0}</div>
      ${(groups[name] || []).map((item) => `<article class="deal">
        <div class="primary-text">${escapeHtml(item.title)}</div>
        <div class="secondary-text">${escapeHtml(item.organization_name)}</div>
        <div class="value"><span class="score">${Number(item.opportunity_score).toFixed(1)}</span> · ${escapeHtml(fmtMoney(item.estimated_value_minor, item.currency))}</div>
      </article>`).join("") || '<div class="empty">Empty</div>'}
    </section>`).join("")}</div>`;
}

async function renderOperations() {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/operations?limit=150`);
  content.innerHTML = `
    ${tablePanel("Recent jobs",["State","Job","Target","Attempts","Cost","Created"],data.jobs.map((item)=>[
      chip(item.state),
      `<div class="primary-text">${escapeHtml(item.job_type)}</div><div class="secondary-text">${escapeHtml(item.capability)}</div>`,
      escapeHtml(item.organization_name),
      `${escapeHtml(item.attempt_count)}/${escapeHtml(item.max_attempts)}`,
      escapeHtml(item.cost_units),
      escapeHtml(fmtDate(item.created_at)),
    ]),"No jobs","Authorized work will appear here.")}
    <div class="split">
      ${tablePanel("Regressions",["Severity","Signal","Target","Status"],data.regressions.map((item)=>[
        chip(item.severity),escapeHtml(item.summary),escapeHtml(item.organization_name),chip(item.status)
      ]),"No regressions","Continuous monitoring is healthy.")}
      ${tablePanel("Monitors",["Monitor","Target","Enabled","Failures"],data.monitors.map((item)=>[
        `<div class="primary-text">${escapeHtml(item.name)}</div><div class="secondary-text">${escapeHtml(item.capability)} · ${escapeHtml(item.cadence_minutes)}m</div>`,
        escapeHtml(item.organization_name),
        chip(item.enabled ? "ACTIVE" : "DISABLED"),
        escapeHtml(item.consecutive_failures),
      ]),"No monitors","Create a continuous monitor from a target.")}
    </div>`;
}

async function renderTeam() {
  const [members, keys, subscription] = await Promise.all([
    api(`/v1/platform/workspaces/${state.workspaceId}/members`).catch(() => ({ members: [] })),
    api(`/v1/platform/workspaces/${state.workspaceId}/api-keys`).catch(() => ({ apiKeys: [] })),
    api(`/v1/platform/workspaces/${state.workspaceId}/subscription`),
  ]);
  content.innerHTML = `
    <div class="grid metrics">
      ${metric("Plan", subscription.workspace.plan, subscription.workspace.subscriptionStatus)}
      ${metric("Members", subscription.counts.members, `limit ${subscription.limits.members ?? "∞"}`)}
      ${metric("Targets", subscription.counts.targets, `limit ${subscription.limits.targets ?? "∞"}`)}
      ${metric("Jobs this month", subscription.usage.jobs_created || 0, `limit ${subscription.limits.jobsPerMonth ?? "∞"}`)}
    </div>
    <div class="split">
      ${tablePanel("Members",["Person","Role","Status"],members.members.map((item)=>[
        `<div class="primary-text">${escapeHtml(item.displayName)}</div><div class="secondary-text">${escapeHtml(item.email)}</div>`,
        chip(item.role),chip(item.status)
      ]),"No members","Invite collaborators with bounded roles.")}
      ${tablePanel("API keys",["Name","Prefix","Scopes","Last used"],keys.apiKeys.map((item)=>[
        escapeHtml(item.name),`<code>${escapeHtml(item.key_prefix)}</code>`,escapeHtml((item.scopes||[]).join(", ")),escapeHtml(fmtDate(item.last_used_at))
      ]),"No API keys","Create scoped keys for trusted automation.")}
    </div>`;
}

async function renderAudit() {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/audit?limit=200`);
  content.innerHTML = tablePanel(
    "Audit timeline",
    ["Event", "Target", "Job", "Time"],
    data.events.map((item)=>[
      `<div class="primary-text">${escapeHtml(item.event_type)}</div>`,
      escapeHtml(item.target_id || "—"),
      escapeHtml(item.job_id || "—"),
      escapeHtml(fmtDate(item.created_at)),
    ]),
    "No audit events",
    "Workspace actions will leave an audit trail.",
  );
}

async function renderIntegrations() {
  try {
    const data = await api(`/v1/platform/workspaces/${state.workspaceId}/integrations`);
    content.innerHTML = tablePanel(
      "Connected systems",
      ["Provider","Name","Status","Last success","Last error"],
      (data.integrations || []).map((item)=>[
        chip(item.provider),escapeHtml(item.name),chip(item.status),
        escapeHtml(fmtDate(item.lastSuccessAt)),escapeHtml(item.lastErrorCode || "—")
      ]),
      "No integrations",
      "Connect GitHub, Slack, Stripe, or signed webhooks.",
    );
  } catch (error) {
    if (error.status !== 404) throw error;
    content.innerHTML = `<div class="panel"><div class="empty"><strong>Integration adapters are not enabled yet</strong>The core workspace remains isolated until a provider is configured.</div></div>`;
  }
}

function tablePanel(title, headers, rows, emptyTitle, emptyCopy) {
  return `<section class="panel">
    <div class="panel-header"><h2>${escapeHtml(title)}</h2><span class="chip neutral">${rows.length}</span></div>
    ${rows.length ? `<div class="table-wrap"><table class="table"><thead><tr>${headers.map(h=>`<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>
      ${rows.map(row=>`<tr>${row.map(cell=>`<td>${cell}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>` : `<div class="empty"><strong>${escapeHtml(emptyTitle)}</strong>${escapeHtml(emptyCopy)}</div>`}
  </section>`;
}

function openModal(title, kicker, html) {
  $("#modal-title").textContent = title;
  $("#modal-kicker").textContent = kicker;
  $("#modal-content").innerHTML = html;
  modal.showModal();
}

function openTargetForm() {
  openModal("Register target","AUTHORIZED SCOPE",`
    <form id="target-form">
      <div class="form-grid">
        <label>Organization<input name="organizationName" maxlength="240" required></label>
        <label>Base URL<input name="baseUrl" type="url" placeholder="https://example.com" required></label>
        <label>Authorization mode<select name="mode"><option>PUBLIC_QA_ONLY</option><option>BUG_BOUNTY</option><option>DO_NOT_TEST</option></select></label>
        <label>Expires at<input name="expiresAt" type="datetime-local"></label>
        <label class="full">Scope notes<textarea name="scopeNotes" rows="3"></textarea></label>
        <label class="full">Evidence reference<input name="evidenceReference" maxlength="1000" placeholder="Contract, bounty program, ticket, or other authorization evidence"></label>
        <div class="full">
          <span class="eyebrow">Capabilities</span>
          <label><input name="browser" type="checkbox"> Browser QA</label>
          <span class="muted">Source remediation is unlocked from Authorization Center after DNS ownership verification.</span>
        </div>
      </div>
      <div class="form-actions"><button class="button" type="button" id="target-cancel">Cancel</button><button class="button primary" type="submit">Register target</button></div>
    </form>`);
  $("#target-cancel").addEventListener("click",()=>modal.close());
  $("#target-form").addEventListener("submit", async (event)=>{
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const url = new URL(form.get("baseUrl"));
      const capabilities = ["PUBLIC_HTTP_OBSERVE"];
      if (form.get("browser")) capabilities.push("BROWSER_QA");
      await api(`/v1/platform/workspaces/${state.workspaceId}/targets`,{
        method:"POST",
        body:JSON.stringify({
          organizationName:form.get("organizationName"),
          baseUrl:url.toString(),
          authorization:{
            mode:form.get("mode"),
            allowedHosts:[url.hostname],
            allowedCapabilities:capabilities,
            scopeNotes:form.get("scopeNotes") || null,
            evidenceReference:form.get("evidenceReference") || null,
            expiresAt:form.get("expiresAt") ? new Date(form.get("expiresAt")).toISOString() : null,
          },
        }),
      });
      modal.close();toast("Target registered");navigateConsole("/console/targets");
    } catch(error){toast(error.message,true);}
  });
}

function openInviteForm() {
  openModal("Invite member","WORKSPACE ACCESS",`
    <form id="invite-form"><div class="form-grid">
      <label class="full">Email<input name="email" type="email" required></label>
      <label>Role<select name="role"><option>VIEWER</option><option>OPERATOR</option><option>ADMIN</option></select></label>
    </div><div class="form-actions"><button class="button" type="button" id="invite-cancel">Cancel</button><button class="button primary" type="submit">Create invite</button></div></form>`);
  $("#invite-cancel").addEventListener("click",()=>modal.close());
  $("#invite-form").addEventListener("submit",async(event)=>{
    event.preventDefault();const form=new FormData(event.currentTarget);
    try{
      const result=await api(`/v1/platform/workspaces/${state.workspaceId}/invites`,{method:"POST",body:JSON.stringify({email:form.get("email"),role:form.get("role")})});
      $("#modal-content").innerHTML=`<p class="muted">Share this one-time invite token through a trusted channel. It expires automatically.</p><pre class="code-block" id="invite-token"></pre>`;
      $("#invite-token").textContent=result.inviteToken;toast("Invite created");
    }catch(error){toast(error.message,true);}
  });
}

function primaryAction() {
  if (["overview","targets"].includes(state.view)) return openTargetForm();
  if (state.view === "launch" || state.view === "operator") return render();
  if (state.view === "team") return openInviteForm();
  if (state.view === "integrations") {
    document.dispatchEvent(new CustomEvent("open-integration-form"));
    return;
  }
  render();
}

function signOut(notify=true) {
  const oldToken=state.token;
  state.token="";
  state.me=null;
  sessionStorage.removeItem("mecord_session");
  if (oldToken) fetch("/v1/platform/auth/logout",{method:"POST",headers:{Authorization:`Bearer ${oldToken}`}}).catch(()=>{});
  showAuth();
  if(notify) toast("Signed out");
}

$("#signup-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  try{
    const result=await api("/v1/platform/auth/signup",{method:"POST",body:JSON.stringify({
      email:$("#signup-email").value,
      displayName:$("#signup-name").value,
      password:$("#signup-password").value,
      workspaceName:$("#signup-workspace").value,
      workspaceSlug:$("#signup-slug").value || $("#signup-workspace").value,
    })});
    state.token=result.token;
    state.workspaceId=result.workspace.id;
    sessionStorage.setItem("mecord_session",state.token);
    sessionStorage.setItem("mecord_workspace",state.workspaceId);
    window.history.replaceState({}, "", "/console/launch");
    await boot();
  }catch(error){toast(error.message,true);}
});
$("#login-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  try{
    const result=await api("/v1/platform/auth/login",{method:"POST",body:JSON.stringify({email:$("#login-email").value,password:$("#login-password").value})});
    state.token=result.token;sessionStorage.setItem("mecord_session",state.token);await boot();
  }catch(error){toast(error.message,true);}
});
$("#bootstrap-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  try{
    const result=await fetch("/v1/platform/bootstrap",{method:"POST",headers:{"content-type":"application/json",Authorization:`Bearer ${$("#bootstrap-token").value}`},body:JSON.stringify({
      email:$("#bootstrap-email").value,displayName:$("#bootstrap-name").value,password:$("#bootstrap-password").value,
      workspaceName:$("#bootstrap-workspace").value,workspaceSlug:$("#bootstrap-slug").value || $("#bootstrap-workspace").value,
    })});
    const payload=await result.json();if(!result.ok) throw new Error(payload.message||payload.error);
    state.token=payload.token;state.workspaceId=payload.workspace.id;sessionStorage.setItem("mecord_session",state.token);sessionStorage.setItem("mecord_workspace",state.workspaceId);await boot();
  }catch(error){toast(error.message,true);}
});
$("#show-signup").addEventListener("click",()=>{$("#login-form").classList.add("hidden");$("#signup-form").classList.remove("hidden");});
$("#signup-back-login").addEventListener("click",()=>{$("#signup-form").classList.add("hidden");$("#login-form").classList.remove("hidden");});
$("#show-bootstrap").addEventListener("click",()=>{$("#login-form").classList.add("hidden");$("#bootstrap-form").classList.remove("hidden");});
$("#show-login").addEventListener("click",()=>{$("#bootstrap-form").classList.add("hidden");$("#login-form").classList.remove("hidden");});
$("#workspace-select").addEventListener("change",async(event)=>{
  state.workspaceId=event.target.value;
  sessionStorage.setItem("mecord_workspace",state.workspaceId);
  if (state.view === "findingDetail") {
    navigateConsole("/console/findings");
    return;
  }
  await render();
});
$("#nav").addEventListener("click",(event)=>{
  const button=event.target.closest(".nav-item");
  if(!button)return;
  navigateConsole(button.dataset.route || pathForView[button.dataset.view] || "/console/home");
});
$("#refresh-button").addEventListener("click",render);
$("#primary-action").addEventListener("click",primaryAction);
$("#logout-button").addEventListener("click",()=>signOut());
const commands = [
  { label: "Home", meta: "Workspace pulse and action queue", route: "/console/home" },
  { label: "Targets", meta: "Authorized assets", route: "/console/targets" },
  { label: "Findings", meta: "Verified engineering evidence", route: "/console/findings" },
  { label: "Approval inbox", meta: "Human-gated decisions", route: "/console/approvals" },
  { label: "Runs", meta: "Runtime and failure recovery", route: "/console/runs" },
  { label: "Opportunities", meta: "Repair to revenue", route: "/console/revenue" },
  { label: "Integrations", meta: "Provider connections", route: "/console/integrations" },
  { label: "Team & Access", meta: "Members and API keys", route: "/console/workspace/access" },
  { label: "Audit", meta: "Workspace governance", route: "/console/workspace/audit" },
  { label: "Add target", meta: "Register authorized scope", action: openTargetForm },
];

function renderCommands(query = "") {
  const needle = query.trim().toLowerCase();
  const available = commands.filter((item) =>
    !needle || (item.label + " " + item.meta).toLowerCase().includes(needle),
  );
  $("#command-results").innerHTML = available.length
    ? available.map((item, index) => `<button class="command-item" type="button" data-command="${index}">
        <div><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.meta)}</span></div>
        <span>↵</span>
      </button>`).join("")
    : '<div class="empty"><strong>No command found</strong>Try a page name or action.</div>';
  $("#command-results").querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = available[Number(button.dataset.command)];
      $("#command-palette").close();
      if (item.route) navigateConsole(item.route);
      else item.action?.();
    });
  });
}

function openCommandPalette() {
  renderCommands("");
  $("#command-query").value = "";
  $("#command-palette").showModal();
  queueMicrotask(() => $("#command-query").focus());
}

$("#command-button").addEventListener("click", openCommandPalette);
$("#command-query").addEventListener("input", (event) => renderCommands(event.target.value));
$("#command-palette").addEventListener("click", (event) => {
  if (event.target === $("#command-palette")) $("#command-palette").close();
});

window.addEventListener("console:navigate", async (event) => {
  applyRoute(event.detail);
  if (state.token && state.me) await render();
});
window.addEventListener("popstate", async () => {
  applyRoute(parseConsoleRoute());
  if (state.token && state.me) await render();
});

document.addEventListener("keydown",(event)=>{
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (state.token && state.me) openCommandPalette();
    return;
  }
  if (event.key === "Escape" && $("#command-palette").open) {
    $("#command-palette").close();
    return;
  }
  if(event.target.matches("input,textarea,select"))return;
  const n=Number(event.key);
  if(n>=1&&n<=9){
    const button=[...document.querySelectorAll(".nav-item")].find((item)=>item.querySelector("kbd")?.textContent===String(n));
    if(button)button.click();
  }
});
boot();
