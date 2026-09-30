import { api } from "../core/api.js";
import { escapeHtml, fmtDate } from "../core/format.js";
import { metric, setPageMeta, tablePanel, chip } from "../components/ui.js";

export async function renderOperator({content,signal}){
  const data=await api("/v1/platform/admin/overview?limit=250",{signal,cacheMs:4000});
  if(signal.aborted)return;
  content.innerHTML=`
    <div class="entity-header"><div><p class="eyebrow">PLATFORM OPERATOR</p><h1>Fleet health</h1><div class="entity-subtitle">Separate from ordinary workspace ownership.</div></div></div>
    <div class="metrics">
      ${metric("Active workspaces",data.summary.active_workspaces,"Customer estates")}
      ${metric("Active users",data.summary.active_users,"Platform accounts")}
      ${metric("Pending approvals",data.summary.pending_approvals,"Across workspaces")}
      ${metric("Failed jobs 24h",data.summary.failed_jobs_24h,"Needs attention",data.summary.failed_jobs_24h?"DEGRADED":"HEALTHY")}
    </div>
    <div class="split">
      ${tablePanel({title:"Workspaces",headers:["Workspace","Plan","Subscription","Targets","Members"],rows:data.workspaces.map(i=>[`<span class="primary-text">${escapeHtml(i.name)}</span><div class="secondary-text">${escapeHtml(i.slug)}</div>`,chip(i.plan),chip(i.subscription_status),escapeHtml(i.targets),escapeHtml(i.members)]),emptyTitle:"No workspaces",emptyCopy:"No customer workspaces yet."})}
      ${tablePanel({title:"Fleet alerts",headers:["Type","Workspace","Detail","Time"],rows:data.alerts.map(i=>[chip(i.kind),escapeHtml(i.workspace_id||"—"),escapeHtml(i.detail||"—"),escapeHtml(fmtDate(i.occurred_at))]),emptyTitle:"No alerts",emptyCopy:"The platform fleet is healthy."})}
    </div>`;
  setPageMeta("Platform-level visibility");
}
