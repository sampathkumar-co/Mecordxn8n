import { api, settleRequests } from "../core/api.js";
import { state } from "../core/state.js";
import { permission, disabledAttrs } from "../core/permissions.js";
import { escapeHtml, fmtDate, fmtRelative, safeJson } from "../core/format.js";
import { chip, detail, entityHeader, panel, partialBanner, setPageMeta, tablePanel, $, toast } from "../components/ui.js";
import { openIntegrationForm, testIntegration, toggleIntegration } from "../components/actions.js";

const providerCopy={
  GITHUB:"Issue delivery and signed inbound webhooks.",
  SLACK:"Workspace notifications through Slack incoming webhooks.",
  STRIPE:"Inbound subscription lifecycle events with signature verification.",
  WEBHOOK:"Signed generic HTTPS delivery to a public endpoint.",
};

export async function renderIntegrations({content,signal}){
  const wid=state.workspaceId;
  const {data,errors}=await settleRequests({
    integrations:api(`/v1/platform/workspaces/${wid}/integrations`,{signal,cacheMs:4000}),
    deliveries:api(`/v1/platform/workspaces/${wid}/integrations/deliveries?limit=150`,{signal,cacheMs:3500}),
  });
  if(signal.aborted)return;
  const integrations=data.integrations?.integrations||[];
  const metrics=data.integrations?.metrics||{};
  const deliveries=data.deliveries?.deliveries||[];
  const access=permission("ADMIN", { operational: true });

  content.innerHTML=`
    ${partialBanner(errors)}
    ${entityHeader({eyebrow:"WORKSPACE CONNECTIONS",title:"Integrations",subtitle:"Credentials stay encrypted; delivery state is durable, retried, and workspace-scoped.",badges:[`${integrations.filter(i=>i.status==="ACTIVE").length} ACTIVE`],actions:`<button id="add-integration" class="button primary small" type="button" ${disabledAttrs(access)}>Add integration</button>`})}
    <div class="provider-grid">${Object.entries(providerCopy).map(([provider,copy])=>{
      const count=integrations.filter(i=>i.provider===provider).length;
      return `<article class="provider-card"><div class="provider-logo">${provider[0]}</div><h3>${provider}</h3><p>${escapeHtml(copy)}</p><span class="chip neutral">${count} configured</span></article>`;
    }).join("")}</div>
    <div class="split equal-split">
      ${panel("Connection health",`<div class="panel-body detail-grid">
        ${detail("Active",metrics.connections?.ACTIVE||0)}${detail("Disabled",metrics.connections?.DISABLED||0)}
        ${detail("Sent 24h",metrics.deliveries24h?.SENT||0)}${detail("Pending 24h",metrics.deliveries24h?.PENDING||0)}
        ${detail("Failed 24h",metrics.deliveries24h?.FAILED||0)}${detail("Dead-letter 24h",metrics.deliveries24h?.DEAD_LETTER||0)}
      </div>`)}
      ${panel("Recovery queue",`<div class="panel-body">${deliveries.filter(d=>["FAILED","DEAD_LETTER"].includes(d.state)).slice(0,6).map(d=>`<div class="action-item urgent"><span class="action-rank">!</span><div><strong>${escapeHtml(d.event_type)}</strong><p>${escapeHtml(d.connection_name)} · ${escapeHtml(d.last_error_code||d.state)}</p></div>${chip(d.state)}</div>`).join("")||'<div class="empty"><strong>No delivery failures</strong>Integration delivery is healthy.</div>'}</div>`)}
    </div>
    <div style="margin-top:10px">
      ${tablePanel({
        title:"Connections",headers:["Provider","Connection","State","Events","Last success","Last error","Action"],
        rows:integrations.map(i=>[chip(i.provider),`<a data-link class="row-link" href="/console/integrations/${i.id}"><span class="primary-text">${escapeHtml(i.name)}</span></a>`,chip(i.status),escapeHtml((i.subscribedEvents||[]).join(", ")||"Inbound only"),escapeHtml(fmtRelative(i.lastSuccessAt)),escapeHtml(i.lastErrorCode||"—"),`<a data-link class="button small" href="/console/integrations/${i.id}">Manage</a>`]),
        emptyTitle:"No integrations",emptyCopy:"Connect GitHub, Slack, Stripe, or a signed HTTPS webhook.",
      })}
    </div>
    <div style="margin-top:10px">
      ${tablePanel({
        title:"Recent delivery state",headers:["State","Event","Connection","Attempt","Next retry","Error","Updated"],
        rows:deliveries.map(d=>[chip(d.state),escapeHtml(d.event_type),escapeHtml(d.connection_name),`${d.attempt_count}/${d.max_attempts}`,escapeHtml(fmtRelative(d.next_attempt_at)),escapeHtml(d.last_error_code||"—"),escapeHtml(fmtDate(d.updated_at))]),
        emptyTitle:"No deliveries",emptyCopy:"Subscribed product events will create durable outbox deliveries.",
        subtitle:"Payloads, provider secrets, and encrypted configuration are never rendered here.",
      })}
    </div>`;
  $("#add-integration")?.addEventListener("click",openIntegrationForm);
  setPageMeta("Encrypted config · signed webhooks · bounded delivery retries");
}

export async function renderIntegrationDetail({content,signal,route}){
  const wid=state.workspaceId;
  const {data,errors}=await settleRequests({
    integrations:api(`/v1/platform/workspaces/${wid}/integrations`,{signal,cacheMs:3000}),
    deliveries:api(`/v1/platform/workspaces/${wid}/integrations/deliveries?limit=250`,{signal,cacheMs:3000}),
  });
  if(signal.aborted)return;
  const item=(data.integrations?.integrations||[]).find(i=>i.id===route.params.id);
  if(!item)throw Object.assign(new Error("Integration not found in this workspace."),{status:404});
  const deliveries=(data.deliveries?.deliveries||[]).filter(d=>d.connection_id===item.id);
  const access=permission("ADMIN", { operational: true });
  const publicConfig=Object.entries(item.publicConfig||{});

  content.innerHTML=`
    ${partialBanner(errors)}
    ${entityHeader({
      eyebrow:"INTEGRATION",title:item.name,subtitle:item.provider,
      badges:[item.status,item.provider],
      actions:`<button id="integration-test" class="button small" type="button" ${item.provider==="STRIPE"?"disabled title=\"Stripe is inbound-only\"":disabledAttrs(access)}>Test</button><button id="integration-toggle" class="button ${item.status==="ACTIVE"?"danger":"primary"} small" type="button" ${disabledAttrs(access)}>${item.status==="ACTIVE"?"Disable":"Enable"}</button>`,
    })}
    <div class="split">
      ${panel("Connection",`<div class="panel-body detail-grid">
        ${detail("Provider",item.provider)}${detail("Status",item.status)}${detail("Subscribed events",(item.subscribedEvents||[]).join(", ")||"Inbound only")}
        ${detail("Last success",fmtDate(item.lastSuccessAt))}${detail("Last error",item.lastErrorCode||"—")}${detail("Updated",fmtDate(item.updatedAt))}
      </div>`)}
      ${panel("Public configuration",`<div class="panel-body detail-grid">${publicConfig.map(([k,v])=>detail(k,typeof v==="object"?safeJson(v):String(v))).join("")||detail("Secrets","Configured values are hidden")}</div><div class="panel-body"><p class="muted">Secret values and ciphertext never leave the server.</p></div>`)}
    </div>
    <div style="margin-top:10px">
      ${tablePanel({
        title:"Delivery history",headers:["State","Event","Attempt","Worker","Next retry","Provider ref","Error","Created"],
        rows:deliveries.map(d=>[chip(d.state),escapeHtml(d.event_type),`${d.attempt_count}/${d.max_attempts}`,escapeHtml(d.lease_owner||"—"),escapeHtml(fmtRelative(d.next_attempt_at)),escapeHtml(d.provider_reference||"—"),escapeHtml(d.last_error_code||"—"),escapeHtml(fmtDate(d.created_at))]),
        emptyTitle:"No deliveries",emptyCopy:"No outbox event has targeted this connection yet.",
      })}
    </div>`;
  $("#integration-test")?.addEventListener("click",()=>testIntegration(item).catch(e=>toast(e.message,true)));
  $("#integration-toggle")?.addEventListener("click",()=>toggleIntegration(item,item.status!=="ACTIVE").catch(e=>toast(e.message,true)));
  setPageMeta("Provider secrets hidden by design");
}
