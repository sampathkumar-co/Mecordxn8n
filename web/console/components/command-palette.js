import { api, settleRequests } from "../core/api.js";
import { state } from "../core/state.js";
import { navigate } from "../core/router.js";
import { escapeHtml } from "../core/format.js";
import { $, toast } from "./ui.js";
import { openIntegrationForm, openInviteForm, openTargetForm } from "./actions.js";

let items = [];
let active = 0;
let loadedWorkspace = "";\nlet returnFocus = null;

function staticItems() {
  return [
    { label: "Home", meta: "Workspace pulse", path: "/console/home", keywords: "dashboard health" },
    { label: "Targets", meta: "Engineering", path: "/console/targets", keywords: "assets authorization" },
    { label: "Findings", meta: "Engineering", path: "/console/findings", keywords: "proof evidence issues" },
    { label: "Runs & regressions", meta: "Engineering", path: "/console/runs", keywords: "jobs operations failures" },
    { label: "Approval inbox", meta: "Repair", path: "/console/approvals", keywords: "human gates approve" },
    { label: "Repair queue", meta: "Repair", path: "/console/repairs", keywords: "remediation" },
    { label: "Revenue", meta: "Opportunities", path: "/console/revenue", keywords: "pipeline money services" },
    { label: "Integrations", meta: "Workspace", path: "/console/integrations", keywords: "github slack stripe webhook" },
    { label: "Team & access", meta: "Workspace", path: "/console/workspace/access", keywords: "members api keys" },
    { label: "Add target", meta: "Command", action: openTargetForm, keywords: "create register" },
    { label: "Add integration", meta: "Command", action: openIntegrationForm, keywords: "connect provider" },
    { label: "Invite member", meta: "Command", action: openInviteForm, keywords: "team user" },
  ];
}

async function loadDynamic() {
  if (!state.workspaceId || loadedWorkspace === state.workspaceId) return;
  loadedWorkspace = state.workspaceId;
  const { data } = await settleRequests({
    targets: api(`/v1/platform/workspaces/${state.workspaceId}/targets?limit=60`, { cacheMs: 15000 }),
    findings: api(`/v1/platform/workspaces/${state.workspaceId}/findings?limit=80`, { cacheMs: 15000 }),
    approvals: api(`/v1/platform/workspaces/${state.workspaceId}/approvals?limit=50`, { cacheMs: 10000 }),
  });
  const dynamic = [
    ...(data.targets?.targets || []).map((item) => ({
      label: item.organizationName,
      meta: `Target · ${item.authorizationMode || "No authorization"}`,
      path: `/console/targets/${item.id}`,
      keywords: item.baseUrl,
    })),
    ...(data.findings?.findings || []).map((item) => ({
      label: item.title,
      meta: `Finding · ${item.severity} · ${item.organizationName}`,
      path: `/console/findings/${item.id}`,
      keywords: `${item.category} ${item.affectedUrl}`,
    })),
    ...(data.approvals?.approvals || []).map((item) => ({
      label: item.action_type,
      meta: `Approval · ${item.status} · ${item.organization_name}`,
      path: `/console/approvals/${item.id}`,
      keywords: item.requested_by,
    })),
  ];
  items = [...staticItems(), ...dynamic];
}

function visibleItems() {
  const query = $("#palette-input").value.trim().toLowerCase();
  const source = items.length ? items : staticItems();
  if (!query) return source.slice(0, 18);
  return source.filter((item) =>
    `${item.label} ${item.meta} ${item.keywords || ""}`.toLowerCase().includes(query)
  ).slice(0, 30);
}

function render() {
  const results = visibleItems();
  active = Math.max(0, Math.min(active, results.length - 1));
  $("#palette-results").innerHTML = results.length
    ? results.map((item, index) => `<button class="palette-item ${index === active ? "active" : ""}" data-palette-index="${index}" type="button" role="option" aria-selected="${index === active}">
        <span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.meta)}</small></span><span class="muted">↵</span>
      </button>`).join("")
    : '<div class="empty"><strong>No matches</strong>Try another workspace object or command.</div>';
  return results;
}

function execute(item) {
  const palette = $("#command-palette");
  palette.close();
  if (item.path) navigate(item.path);
  else if (item.action) item.action();
}

export async function openCommandPalette() {
  const palette = $("#command-palette");
  returnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  items = staticItems();
  active = 0;
  $("#palette-input").value = "";
  palette.showModal();
  render();
  $("#palette-input").focus();
  try { await loadDynamic(); render(); } catch (error) { toast(error.message, true); }
}

$("#palette-input")?.addEventListener("input", () => { active = 0; render(); });
$("#palette-results")?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-palette-index]");
  if (!button) return;
  execute(visibleItems()[Number(button.dataset.paletteIndex)]);
});
$("#command-palette")?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); active += 1; render(); }
  if (event.key === "ArrowUp") { event.preventDefault(); active -= 1; render(); }
  if (event.key === "Enter") {
    const item = visibleItems()[active];
    if (item) { event.preventDefault(); execute(item); }
  }
});

$("#command-palette")?.addEventListener("close", () => {
  const target = returnFocus;
  returnFocus = null;
  if (target?.isConnected) target.focus();
});
