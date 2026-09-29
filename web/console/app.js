const state = {
  token: sessionStorage.getItem("mecord_session") || "",
  me: null,
  workspaceId: sessionStorage.getItem("mecord_workspace") || "",
  view: "overview",
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

function toast(message, error = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("error", error);
  node.classList.add("show");
  setTimeout(() => node.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
  if (options.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...options, headers });
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
}

function currentWorkspace() {
  return state.me?.workspaces?.find((item) => item.id === state.workspaceId);
}

const viewMeta = {
  overview: ["WORKSPACE", "Overview", "Add target"],
  targets: ["ASSETS", "Targets", "Add target"],
  findings: ["EVIDENCE", "Findings", "Refresh"],
  approvals: ["HUMAN GATES", "Approvals", "Refresh"],
  pipeline: ["COMMERCIAL", "Pipeline", "Refresh"],
  operations: ["RUNTIME", "Operations", "Refresh"],
  integrations: ["CONNECTIONS", "Integrations", "Add integration"],
  team: ["ACCESS", "Team & Access", "Invite member"],
  audit: ["GOVERNANCE", "Audit", "Refresh"],
};

async function render() {
  const [kicker, title, action] = viewMeta[state.view];
  $("#view-kicker").textContent = kicker;
  $("#view-title").textContent = title;
  $("#primary-action").textContent = action;
  document.querySelectorAll(".nav-item").forEach((node) => {
    node.classList.toggle("active", node.dataset.view === state.view);
  });
  loading();
  try {
    const renderer = {
      overview: renderOverview,
      targets: renderTargets,
      findings: renderFindings,
      approvals: renderApprovals,
      pipeline: renderPipeline,
      operations: renderOperations,
      integrations: renderIntegrations,
      team: renderTeam,
      audit: renderAudit,
    }[state.view];
    await renderer();
    content.focus();
  } catch (error) {
    content.innerHTML = `<div class="panel"><div class="empty"><strong>Could not load this view</strong>${escapeHtml(error.message)}</div></div>`;
    toast(error.message, true);
  }
}

async function renderOverview() {
  const data = await api(`/v1/platform/workspaces/${state.workspaceId}/overview`);
  const revenue = Object.entries(data.revenueByCurrency || {})
    .map(([currency, row]) => `${currency} ${fmtMoney(row.netReceivedMinor, currency)}`)
    .join(" · ") || "No received revenue yet";
  const pipelineCount = Object.values(data.pipeline || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  content.innerHTML = `
    <div class="grid metrics">
      ${metric("Targets", data.targets, "Authorized estates")}
      ${metric("Verified findings", data.findings?.verified || 0, `${data.findings?.high_open || 0} high open`)}
      ${metric("Pending approvals", data.pendingApprovals, "Human decision queue")}
      ${metric("Open regressions", data.openRegressions, "Continuous monitoring")}
    </div>
    <div class="split">
      <section class="panel">
        <div class="panel-header"><h2>Operating pulse</h2><span class="chip ${data.jobs?.dead_letter ? "danger" : "good"}">${data.jobs?.dead_letter || 0} dead-letter</span></div>
        <div class="panel-body detail-grid">
          ${detail("Jobs, last 24h", data.jobs?.last_24h || 0)}
          ${detail("Jobs running", data.jobs?.running || 0)}
          ${detail("Commercial opportunities", pipelineCount)}
          ${detail("Active services", data.services?.active || 0)}
          ${detail("Renewals due ≤ 7d", data.services?.renewals_due || 0)}
          ${detail("Security events, 24h", data.securityEvents24h || 0)}
        </div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>Revenue</h2><span class="chip neutral">Recorded cash</span></div>
        <div class="panel-body">
          <div class="primary-text">${escapeHtml(revenue)}</div>
          <p class="muted">Revenue becomes truth only after recorded payment evidence; pipeline state alone cannot mark an opportunity won.</p>
        </div>
      </section>
    </div>
    <section class="panel" style="margin-top:14px">
      <div class="panel-header"><h2>Workspace boundary</h2><span class="chip good">${escapeHtml(data.workspace?.plan || "—")}</span></div>
      <div class="panel-body detail-grid">
        ${detail("Workspace", data.workspace?.name)}
        ${detail("Subscription", data.workspace?.subscriptionStatus)}
        ${detail("Retention", `${data.workspace?.retentionDays || "—"} days`)}
        ${detail("Role", currentWorkspace()?.role || "API key")}
      </div>
    </section>`;
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
      `<div class="primary-text">${escapeHtml(item.organizationName)}</div>`,
      `<div class="secondary-text">${escapeHtml(item.baseUrl)}</div>`,
      chip(item.authorizationMode),
      escapeHtml(item.findingCount),
      escapeHtml(item.monitorCount),
      escapeHtml(fmtDate(item.createdAt)),
    ]),
    "No targets yet",
    "Register the first authorized website or service boundary.",
  );
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
    button.addEventListener("click", () => openFinding(button.dataset.id));
  });
}

async function openFinding(id) {
  const item = await api(`/v1/platform/workspaces/${state.workspaceId}/findings/${id}`);
  openModal("Finding evidence", "VERIFIED ENGINEERING SIGNAL", `
    <div class="detail-grid">
      ${detail("Severity", item.severity)}
      ${detail("Status", item.status)}
      ${detail("Verification", item.verification_state)}
      ${detail("Occurrences", item.occurrences)}
      ${detail("Affected URL", item.affected_url)}
      ${detail("Opportunity score", item.opportunity_score ?? "—")}
    </div>
    <h3>Evidence</h3>
    <pre class="code-block">${escapeHtml(JSON.stringify(item.evidence || {}, null, 2))}</pre>
    <h3>Verification history</h3>
    <pre class="code-block">${escapeHtml(JSON.stringify(item.verifications || [], null, 2))}</pre>
    <h3>Artifacts</h3>
    <pre class="code-block">${escapeHtml(JSON.stringify(item.artifacts || [], null, 2))}</pre>`);
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
        <label>Authorization mode<select name="mode"><option>PUBLIC_QA_ONLY</option><option>BUG_BOUNTY</option><option>CLIENT_AUTHORIZED</option><option>DO_NOT_TEST</option></select></label>
        <label>Expires at<input name="expiresAt" type="datetime-local"></label>
        <label class="full">Scope notes<textarea name="scopeNotes" rows="3"></textarea></label>
        <label class="full">Evidence reference<input name="evidenceReference" maxlength="1000" placeholder="Contract, bounty program, ticket, or other authorization evidence"></label>
        <div class="full">
          <span class="eyebrow">Capabilities</span>
          <label><input name="browser" type="checkbox"> Browser QA</label>
          <label><input name="remediation" type="checkbox"> Source remediation (client authorization still required)</label>
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
      if (form.get("remediation")) capabilities.push("SOURCE_REMEDIATION");
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
      modal.close();toast("Target registered");state.view="targets";await render();
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
$("#show-bootstrap").addEventListener("click",()=>{$("#login-form").classList.add("hidden");$("#bootstrap-form").classList.remove("hidden");});
$("#show-login").addEventListener("click",()=>{$("#bootstrap-form").classList.add("hidden");$("#login-form").classList.remove("hidden");});
$("#workspace-select").addEventListener("change",async(event)=>{state.workspaceId=event.target.value;sessionStorage.setItem("mecord_workspace",state.workspaceId);await render();});
$("#nav").addEventListener("click",async(event)=>{const button=event.target.closest(".nav-item");if(!button)return;state.view=button.dataset.view;await render();});
$("#refresh-button").addEventListener("click",render);
$("#primary-action").addEventListener("click",primaryAction);
$("#logout-button").addEventListener("click",()=>signOut());
document.addEventListener("keydown",(event)=>{if(event.target.matches("input,textarea,select"))return;const n=Number(event.key);if(n>=1&&n<=9){const button=document.querySelectorAll(".nav-item")[n-1];if(button)button.click();}});
boot();
