import { api, settleRequests } from "../core/api.js";
import { state } from "../core/state.js";
import { escapeHtml, fmtDate, fmtMoney, fmtRelative, fmtNumber } from "../core/format.js";
import { chip, detail, entityHeader, metric, panel, partialBanner, setPageMeta, tablePanel, $, $$ } from "../components/ui.js";

const stages = ["NEW","QUALIFIED","ENGAGED","PROPOSAL","NEGOTIATING","WON","LOST","PAUSED"];

function opportunityCard(item) {
  return `<a class="lifecycle-card" data-link href="/console/revenue/${item.id}">
    <strong>${escapeHtml(item.title)}</strong>
    <p>${escapeHtml(item.organization_name)} · score ${escapeHtml(fmtNumber(item.opportunity_score))}</p>
    <p>${escapeHtml(fmtMoney(item.estimated_value_minor, item.currency))} · ${escapeHtml(item.responses)} responses</p>
  </a>`;
}

export async function renderRevenue({ content, signal }) {
  const wid = state.workspaceId;
  const { data, errors } = await settleRequests({
    pipeline: api(`/v1/platform/workspaces/${wid}/pipeline?limit=400`, { signal, cacheMs: 5000 }),
    overview: api(`/v1/platform/workspaces/${wid}/overview`, { signal, cacheMs: 7000 }),
  });
  if (signal.aborted) return;
  const items = data.pipeline?.opportunities || [];
  const overview = data.overview || {};
  const openCount = items.filter((item) => !["WON","LOST"].includes(item.state)).length;
  const revenueSummary = Object.entries(overview.revenueByCurrency || {})
    .map(([currency,row]) => fmtMoney(row.netReceivedMinor,currency)).join(" · ") || "No received revenue";

  content.innerHTML = `
    ${partialBanner(errors)}
    ${entityHeader({
      eyebrow:"REVENUE", title:"Opportunities", subtitle:"Commercial state remains anchored to verified findings, released reports, consent, and payment evidence.",
      badges:[`${openCount} OPEN`],
      actions:'<div class="filters"><button id="revenue-kanban" class="button small primary" type="button">Board</button><button id="revenue-list" class="button small" type="button">List</button></div>',
    })}
    <div class="metrics">
      ${metric("Open opportunities", openCount, `${items.length} total records`)}
      ${metric("Recorded cash", revenueSummary, "Payment evidence, net of refunds")}
      ${metric("Active services", overview.services?.active || 0, "Recurring engineering services")}
      ${metric("Renewals due ≤ 7d", overview.services?.renewals_due || 0, "Customer follow-up window")}
    </div>
    <div id="revenue-board" style="margin-top:10px">
      <div class="lifecycle">${stages.map((stage) => {
        const group=items.filter((item)=>item.state===stage);
        return `<section class="lifecycle-col"><div class="lifecycle-head">${stage} · ${group.length}</div>${group.map(opportunityCard).join("") || '<div class="empty">Empty</div>'}</section>`;
      }).join("")}</div>
    </div>
    <div id="revenue-table" class="hidden" style="margin-top:10px">
      ${tablePanel({
        title:"Opportunity list",headers:["State","Opportunity","Target","Score","Value","Actions","Responses","Next action"],
        rows:items.map((item)=>[chip(item.state),`<a data-link class="row-link" href="/console/revenue/${item.id}"><span class="primary-text">${escapeHtml(item.title)}</span></a>`,escapeHtml(item.organization_name),`${fmtNumber(item.opportunity_score)}/100`,escapeHtml(fmtMoney(item.estimated_value_minor,item.currency)),escapeHtml(item.sent_actions),escapeHtml(item.responses),escapeHtml(fmtRelative(item.next_action_at))]),
        emptyTitle:"No opportunities",emptyCopy:"Verified findings can become commercial opportunities through the controlled revenue workflow.",
      })}
    </div>`;
  setPageMeta("Engineering proof remains the source of commercial context");

  $("#revenue-kanban").addEventListener("click", () => {
    $("#revenue-board").classList.remove("hidden"); $("#revenue-table").classList.add("hidden");
    $("#revenue-kanban").classList.add("primary"); $("#revenue-list").classList.remove("primary");
  });
  $("#revenue-list").addEventListener("click", () => {
    $("#revenue-board").classList.add("hidden"); $("#revenue-table").classList.remove("hidden");
    $("#revenue-list").classList.add("primary"); $("#revenue-kanban").classList.remove("primary");
  });
}

export async function renderOpportunityDetail({ content, signal, route }) {
  const wid=state.workspaceId;
  const detailData=await api(`/v1/platform/workspaces/${wid}/opportunities/${route.params.id}`,{signal,cacheMs:3500});
  if(signal.aborted)return;
  const o=detailData.opportunity;
  const requests={};
  if(o.primary_finding_id)requests.finding=api(`/v1/platform/workspaces/${wid}/findings/${o.primary_finding_id}`,{signal,cacheMs:3500});
  const {data,errors}=await settleRequests(requests);
  if(signal.aborted)return;

  content.innerHTML=`
    ${partialBanner(errors)}
    ${entityHeader({
      eyebrow:"OPPORTUNITY",title:o.title,subtitle:o.organization_name,
      badges:[o.state,`SCORE ${fmtNumber(o.opportunity_score)}`],
      actions:`<a class="button small" data-link href="/console/revenue">Back to pipeline</a>${o.primary_finding_id?`<a class="button small primary" data-link href="/console/findings/${o.primary_finding_id}">Open source proof</a>`:""}`,
    })}
    <div class="split">
      ${panel("Commercial context",`<div class="panel-body detail-grid">
        ${detail("State",o.state)}${detail("Opportunity score",`${fmtNumber(o.opportunity_score)}/100`)}
        ${detail("Estimated value",fmtMoney(o.estimated_value_minor,o.currency))}${detail("Next action",fmtDate(o.next_action_at))}
        ${detail("Created",fmtDate(o.created_at))}${detail("Updated",fmtDate(o.updated_at))}
      </div>`)}
      ${panel("Proof anchor",data.finding?`<div class="panel-body"><strong>${escapeHtml(data.finding.title)}</strong><p class="muted">${escapeHtml(data.finding.affected_url)}</p><div class="filters">${chip(data.finding.severity)}${chip(data.finding.verification_state)}</div></div>`:'<div class="empty"><strong>No linked finding</strong>This opportunity has no currently available primary finding.</div>',{badge:data.finding?.verification_state||"—"})}
    </div>
    <div class="split">
      ${panel("Outreach & responses",`<div class="panel-body timeline">
        ${(detailData.actions||[]).map((a)=>`<div class="timeline-item"><strong>${escapeHtml(a.kind)} · ${escapeHtml(a.state)}</strong><p>${escapeHtml(a.channel)} · ${escapeHtml(fmtDate(a.created_at))}${a.failure_code?` · ${escapeHtml(a.failure_code)}`:""}</p></div>`).join("")||'<span class="muted">No outbound actions recorded.</span>'}
        ${(detailData.responses||[]).map((r)=>`<div class="timeline-item"><strong>Response · ${escapeHtml(r.response_type)}</strong><p>${escapeHtml(r.summary||"No summary")} · ${escapeHtml(fmtDate(r.occurred_at))}</p></div>`).join("")}
      </div>`)}
      ${panel("Revenue evidence",`<div class="panel-body timeline">${(detailData.revenueEvents||[]).map((r)=>`<div class="timeline-item"><strong>${escapeHtml(r.kind)} · ${escapeHtml(fmtMoney(r.amount_minor,r.currency))}</strong><p>${escapeHtml(fmtDate(r.occurred_at))}${r.external_reference?` · ref ${escapeHtml(r.external_reference)}`:""}</p></div>`).join("")||'<span class="muted">No revenue events recorded.</span>'}</div>`)}
    </div>
    ${panel("Services & renewals",`<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Status</th><th>Amount</th><th>Cadence</th><th>Renewal</th></tr></thead><tbody>${(detailData.services||[]).map((s)=>`<tr><td>${escapeHtml(s.name)}</td><td>${chip(s.status)}</td><td>${escapeHtml(fmtMoney(s.amount_minor,s.currency))}</td><td>${s.cadence_days?`${escapeHtml(s.cadence_days)}d`:"—"}</td><td>${escapeHtml(fmtDate(s.renewal_at))}</td></tr>`).join("")}</tbody></table></div>`,{badge:String((detailData.services||[]).length)})}
  `;
  setPageMeta("Verified finding → report → approved contact → response → revenue → service");
}
