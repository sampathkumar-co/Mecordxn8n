import { api } from "./core/api.js";
import {
  beginNavigation, currentWorkspace, isCurrentEpoch, markFetched,
  clearBrowserSession, setBrowserSession, setRailCollapsed, setToken,
  setWorkspace, state,
} from "./core/state.js";
import { navigate, parseRoute, routeLabel, startRouter } from "./core/router.js";
import { escapeHtml } from "./core/format.js";
import { currentRole } from "./core/permissions.js";
import { $, $$, errorState, loadingView, setPageMeta, toast } from "./components/ui.js";
import { openCommandPalette } from "./components/command-palette.js";
import {
  openIntegrationForm, openInviteForm, openTargetForm,
} from "./components/actions.js";

import { renderHome } from "./views/home.js";
import { renderTargets, renderTargetDetail } from "./views/targets.js";
import { renderFindings, renderFindingDetail } from "./views/findings.js";
import { renderRuns } from "./views/runs.js";
import { renderApprovals, renderApprovalDetail } from "./views/approvals.js";
import { renderRepairs, renderRepairDetail } from "./views/repairs.js";
import { renderRevenue, renderOpportunityDetail } from "./views/revenue.js";
import { renderIntegrations, renderIntegrationDetail } from "./views/integrations.js";
import { renderWorkspace } from "./views/workspace.js";
import { renderOperator } from "./views/operator.js";

const authView = $("#auth-view");
const appView = $("#app-view");
const content = $("#content");
const sidebar = $("#sidebar");

const renderers = {
  home: renderHome,
  targets: renderTargets,
  "target-detail": renderTargetDetail,
  findings: renderFindings,
  "finding-detail": renderFindingDetail,
  runs: renderRuns,
  approvals: renderApprovals,
  "approval-detail": renderApprovalDetail,
  repairs: renderRepairs,
  "repair-detail": renderRepairDetail,
  revenue: renderRevenue,
  "opportunity-detail": renderOpportunityDetail,
  integrations: renderIntegrations,
  "integration-detail": renderIntegrationDetail,
  workspace: renderWorkspace,
  operator: renderOperator,
};

const routePrimaryActions = {
  home: ["Add target", openTargetForm],
  targets: ["Add target", openTargetForm],
  integrations: ["Add integration", openIntegrationForm],
};

function showAuth() {
  authView.classList.remove("hidden");
  appView.classList.add("hidden");
}

function showApp() {
  authView.classList.add("hidden");
  appView.classList.remove("hidden");
}

function hydrateShell() {
  const select = $("#workspace-select");
  select.innerHTML = (state.me?.workspaces || []).map((workspace) =>
    `<option value="${escapeHtml(workspace.id)}"${workspace.id===state.workspaceId?" selected":""}>${escapeHtml(workspace.name)} · ${escapeHtml(workspace.role||workspace.plan||"")}</option>`
  ).join("");

  const user = state.me?.principal?.user;
  $("#user-chip").innerHTML = user
    ? `<strong>${escapeHtml(user.displayName)}</strong><span>${escapeHtml(user.email)}</span>`
    : "<strong>API key</strong><span>Workspace-scoped access</span>";

  $("#operator-nav").classList.toggle("hidden", !user?.isPlatformOperator);
  $("#role-badge").textContent = currentRole();
  sidebar.classList.toggle("collapsed", state.railCollapsed);
  $("#sidebar-toggle").setAttribute("aria-expanded", state.railCollapsed ? "false" : "true");
}

function setConnection(status) {
  const badge=$("#connection-badge");
  badge.className="status-pill";
  if(status==="offline"){badge.classList.add("danger");badge.textContent="● Offline";}
  else if(status==="degraded"){badge.classList.add("warn");badge.textContent="● Degraded";}
  else{badge.classList.add("good");badge.textContent="● Online";}
}

function breadcrumbFor(route) {
  const labels = [];
  if (route.area === "engineering") labels.push(["Engineering", "/console/findings"]);
  else if (route.area === "repair") labels.push(["Repair", "/console/approvals"]);
  else if (route.area === "revenue") labels.push(["Revenue", "/console/revenue"]);
  else if (route.area === "workspace") labels.push(["Workspace", "/console/workspace/access"]);
  else if (route.area === "operator") labels.push(["Platform", "/console/operator"]);

  const current = routeLabel(route);
  return `${labels.map(([label,path])=>`<a data-link href="${path}">${escapeHtml(label)}</a><span class="breadcrumb-sep">/</span>`).join("")}<strong>${escapeHtml(current)}</strong>`;
}

function updateNavigation(route) {
  $("#breadcrumb").innerHTML = breadcrumbFor(route);
  document.title = `${routeLabel(route)} · Mecordxn8n`;

  $("[data-link][data-area], [data-link][data-route-name]").forEach((node) => {
    const nodePath = new URL(node.href, location.href).pathname.replace(/\/$/, "");
    const routePath = route.pathname.replace(/\/$/, "");
    const workspaceExact =
      node.dataset.routeName === "workspace" &&
      route.name === "workspace" &&
      nodePath === routePath;
    const active = node.dataset.area === route.area ||
      workspaceExact ||
      (node.dataset.routeName === route.name && route.name !== "workspace") ||
      (node.dataset.routeName === "targets" && route.name === "target-detail") ||
      (node.dataset.routeName === "findings" && route.name === "finding-detail") ||
      (node.dataset.routeName === "approvals" && route.name === "approval-detail") ||
      (node.dataset.routeName === "repairs" && route.name === "repair-detail") ||
      (node.dataset.routeName === "revenue" && route.name === "opportunity-detail") ||
      (node.dataset.routeName === "integrations" && route.name === "integration-detail");
    node.classList.toggle("active", active);
    if (active) node.setAttribute("aria-current","page"); else node.removeAttribute("aria-current");
  });

  $$("[data-mobile-area]").forEach((node)=>{
    const active=node.dataset.mobileArea===route.area || (route.area==="operator"&&node.dataset.mobileArea==="workspace");
    node.classList.toggle("active",active);
  });

  const config = routePrimaryActions[route.name] || (route.name === "workspace" && route.params.section === "access"
    ? ["Invite member", openInviteForm]
    : null);
  const primary=$("#primary-action");
  primary.classList.toggle("hidden", !config);
  if(config){
    primary.textContent=config[0];
    primary.onclick=config[1];
  }else{
    primary.onclick=null;
  }
}

async function ensureSubscription(signal) {
  if (state.subscription || !state.workspaceId) return;
  try {
    state.subscription = await api(`/v1/platform/workspaces/${state.workspaceId}/subscription`, {
      signal, cacheMs:10000,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // Individual views surface permission/subscription failures where relevant.
  }
}

async function renderRoute(route = parseRoute()) {
  if (!state.token || !state.me) return;
  if (route.name === "not-found") {
    navigate("/console/home", { replace:true });
    return;
  }
  if (route.name === "operator" && !state.me.principal.user?.isPlatformOperator) {
    navigate("/console/home", { replace:true });
    toast("Platform operator access required", true);
    return;
  }

  const { epoch, signal } = beginNavigation(route);
  updateNavigation(route);
  setPageMeta("");
  content.innerHTML = loadingView();

  try {
    await ensureSubscription(signal);
    const renderer=renderers[route.name];
    if(!renderer) throw new Error("This Control Center route is not implemented.");
    await renderer({ content, signal, route });
    if (!isCurrentEpoch(epoch) || signal.aborted) return;
    markFetched();
    const currentMeta=$("#page-meta").textContent;
    setPageMeta(currentMeta.replace(/ · Updated .*$/,""));
    content.focus({preventScroll:true});
    sidebar.classList.remove("mobile-open");
  } catch (error) {
    if (error?.name === "AbortError" || !isCurrentEpoch(epoch)) return;
    content.innerHTML = errorState(
      error?.status===404 ? "This workspace object could not be found" : "Could not load this view",
      error,
    );
    $("#retry-view")?.addEventListener("click",()=>renderRoute(state.route));
    toast(error.message,true);
  }
}

async function boot() {
  try {
    state.me = await api("/v1/platform/me");
    const workspaces=state.me.workspaces||[];
    if(!workspaces.length) throw new Error("No workspace membership found.");
    if(!workspaces.some((item)=>item.id===state.workspaceId)) setWorkspace(workspaces[0].id);
    hydrateShell();
    showApp();
    const route=parseRoute();
    if(route.name==="not-found" || location.pathname==="/console" || location.pathname==="/console/"){
      navigate("/console/home",{replace:true});
    }else{
      await renderRoute(route);
    }
  } catch (error) {
    if(error?.status===401) clearBrowserSession();
    toast(error.message,true);
    showAuth();
  }
}

async function signOut(notify=true){
  try {
    await api("/v1/platform/auth/logout", { method: "POST", body: "{}" });
  } catch {
    // Local session state is still cleared if the network is unavailable.
  }
  clearBrowserSession();
  state.me=null;state.subscription=null;state.cache.clear();
  showAuth();
  if(notify)toast("Signed out");
}

function authPanel(name){
  ["login-form","signup-form","bootstrap-form"].forEach((id)=>$("#"+id).classList.toggle("hidden",id!==name));
}

$("#login-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  const submit=$("#login-submit");
  submit.disabled=true;
  try{
    const result=await api("/v1/platform/auth/login",{method:"POST",body:JSON.stringify({
      email:$("#login-email").value,
      password:$("#login-password").value,
      mfaCode:$("#login-mfa-row").classList.contains("hidden") ? null : $("#login-mfa-code").value,
    })});
    if(result.mfaRequired){
      $("#login-mfa-row").classList.remove("hidden");
      $("#login-mfa-code").required=true;
      $("#login-mfa-code").focus();
      submit.textContent="Verify and sign in";
      toast("Enter your authenticator code or one-time recovery code.");
      return;
    }
    setBrowserSession(result);
    $("#login-mfa-row").classList.add("hidden");
    $("#login-mfa-code").required=false;
    $("#login-mfa-code").value="";
    submit.textContent="Sign in";
    if(result.recoveryCodeUsed) toast("Recovery code used. Store your remaining recovery codes safely.");
    await boot();
  }catch(error){toast(error.message,true);}
  finally{submit.disabled=false;}
});

$("#signup-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  try{
    const result=await api("/v1/platform/auth/signup",{method:"POST",body:JSON.stringify({
      email:$("#signup-email").value,displayName:$("#signup-name").value,password:$("#signup-password").value,
      workspaceName:$("#signup-workspace").value,workspaceSlug:$("#signup-slug").value||$("#signup-workspace").value,
    })});
    setBrowserSession(result);setWorkspace(result.workspace.id);await boot();navigate("/console/home",{replace:true});
  }catch(error){toast(error.message,true);}
});

$("#bootstrap-form").addEventListener("submit",async(event)=>{
  event.preventDefault();
  try{
    const response=await fetch("/v1/platform/bootstrap",{method:"POST",headers:{
      "content-type":"application/json",
      "X-Mecord-Session-Mode":"cookie",
      Authorization:`Bearer ${$("#bootstrap-token").value}`,
    },body:JSON.stringify({
      email:$("#bootstrap-email").value,displayName:$("#bootstrap-name").value,password:$("#bootstrap-password").value,
      workspaceName:$("#bootstrap-workspace").value,workspaceSlug:$("#bootstrap-slug").value||$("#bootstrap-workspace").value,
    })});
    const payload=await response.json();if(!response.ok)throw new Error(payload.message||payload.error);
    setBrowserSession(payload);setWorkspace(payload.workspace.id);await boot();navigate("/console/home",{replace:true});
  }catch(error){toast(error.message,true);}
});

$("#show-signup").addEventListener("click",()=>authPanel("signup-form"));
$("#signup-back-login").addEventListener("click",()=>authPanel("login-form"));
$("#show-bootstrap").addEventListener("click",()=>authPanel("bootstrap-form"));
$("#show-login").addEventListener("click",()=>authPanel("login-form"));

$("#workspace-select").addEventListener("change",async(event)=>{
  setWorkspace(event.target.value);
  hydrateShell();
  navigate("/console/home");
});

$("#refresh-button").addEventListener("click",()=>renderRoute(state.route||parseRoute()));
$("#logout-button").addEventListener("click",()=>{ void signOut(); });
$("#command-button").addEventListener("click",openCommandPalette);
$("#command-sidebar").addEventListener("click",openCommandPalette);
$("#mobile-menu").addEventListener("click",()=>sidebar.classList.toggle("mobile-open"));
$("#sidebar-toggle").addEventListener("click",()=>{
  setRailCollapsed(!state.railCollapsed);hydrateShell();
});

document.addEventListener("mecord:navigate",(event)=>renderRoute(event.detail));
document.addEventListener("mecord:refresh",()=>renderRoute(state.route||parseRoute()));
document.addEventListener("mecord:create-target",openTargetForm);
document.addEventListener("mecord:connection",(event)=>setConnection(event.detail.status));
document.addEventListener("mecord:auth-expired",()=>{ void signOut(false); });

let pendingG=false;
document.addEventListener("keydown",(event)=>{
  const typing=event.target instanceof HTMLElement && event.target.matches("input,textarea,select,[contenteditable=true]");
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){
    event.preventDefault();openCommandPalette();return;
  }
  if(event.key==="Escape"&&sidebar.classList.contains("mobile-open")){
    sidebar.classList.remove("mobile-open");return;
  }
  if(typing)return;
  if(event.key==="/"){event.preventDefault();openCommandPalette();return;}
  if(event.key.toLowerCase()==="g"){pendingG=true;setTimeout(()=>{pendingG=false;},900);return;}
  if(!pendingG)return;
  pendingG=false;
  const shortcuts={h:"/console/home",f:"/console/findings",a:"/console/approvals",r:"/console/repairs"};
  const path=shortcuts[event.key.toLowerCase()];
  if(path){event.preventDefault();navigate(path);}
});

startRouter();
boot();
