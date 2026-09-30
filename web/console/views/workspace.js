import { api, settleRequests } from "../core/api.js";
import { state, currentWorkspace } from "../core/state.js";
import { permission, disabledAttrs } from "../core/permissions.js";
import { escapeHtml, fmtDate, fmtRelative } from "../core/format.js";
import { chip, detail, entityHeader, metric, panel, partialBanner, setPageMeta, tablePanel, $, $$, toast } from "../components/ui.js";
import { confirmDecision, openModal } from "../components/dialog.js";
import { openApiKeyForm, openBilling, openBillingPortal, openInviteForm, revokeApiKey } from "../components/actions.js";

function workspaceSubnav(active) {
  return `<nav class="workspace-subnav" aria-label="Workspace settings">
    <a data-link href="/console/workspace/access" class="${active === "access" ? "active" : ""}">Team & access</a>
    <a data-link href="/console/workspace/billing" class="${active === "billing" ? "active" : ""}">Billing & usage</a>
    <a data-link href="/console/workspace/audit" class="${active === "audit" ? "active" : ""}">Audit & retention</a>
  </nav>`;
}

export async function renderWorkspace({ content, signal, route }) {
  const section = ["access","billing","audit"].includes(route.params.section) ? route.params.section : "access";
  const wid = state.workspaceId;
  const workspace = currentWorkspace();

  if (section === "access") return renderAccess({ content, signal, wid, workspace, section });
  if (section === "billing") return renderBilling({ content, signal, wid, workspace, section });
  return renderAudit({ content, signal, wid, workspace, section });
}

async function renderAccess({ content, signal, wid, workspace, section }) {
  const { data, errors } = await settleRequests({
    members: api(`/v1/platform/workspaces/${wid}/members`, { signal, cacheMs: 4000 }),
    keys: api(`/v1/platform/workspaces/${wid}/api-keys`, { signal, cacheMs: 4000 }),
    invites: api(`/v1/platform/workspaces/${wid}/invites`, { signal, cacheMs: 4000 }),
    sessions: api("/v1/platform/sessions", { signal, cacheMs: 4000 }),
    subscription: api(`/v1/platform/workspaces/${wid}/subscription`, { signal, cacheMs: 6000 }),
  });
  if (signal.aborted) return;
  if (data.subscription) state.subscription = data.subscription;

  const members = data.members?.members || [];
  const keys = data.keys?.apiKeys || [];
  const invites = data.invites?.invites || [];
  const sessions = data.sessions?.sessions || [];
  const currentSessionId = data.sessions?.currentSessionId;
  const adminAccess = permission("ADMIN");
  const ownerAccess = permission("OWNER");

  content.innerHTML = `
    ${partialBanner(errors)}
    ${entityHeader({
      eyebrow:"WORKSPACE", title:"Team & access", subtitle:workspace?.name || "Workspace",
      badges:[workspace?.role || "ACCESS"],
      actions:`<button id="workspace-invite" class="button primary small" type="button" ${disabledAttrs(adminAccess)}>Invite member</button><button id="workspace-key" class="button small" type="button" ${disabledAttrs(adminAccess)}>Create API key</button>`,
    })}
    <div class="workspace-sections">
      ${workspaceSubnav(section)}
      <div class="stack">
        ${tablePanel({
          title:"Members", headers:["Person","Role","Status","Joined","Control"],
          rows:members.map((item)=>[
            `<div class="primary-text">${escapeHtml(item.displayName)}</div><div class="secondary-text">${escapeHtml(item.email)}</div>`,
            item.role==="OWNER" ? chip("OWNER") : `<select class="member-role" data-user-id="${item.id}" aria-label="Role for ${escapeHtml(item.email)}" ${disabledAttrs(ownerAccess)}><option ${item.role==="VIEWER"?"selected":""}>VIEWER</option><option ${item.role==="OPERATOR"?"selected":""}>OPERATOR</option><option ${item.role==="ADMIN"?"selected":""}>ADMIN</option></select>`,
            chip(item.status),escapeHtml(fmtDate(item.createdAt)),
            item.role==="OWNER" ? "Protected" : `<button class="button danger small member-remove" data-user-id="${item.id}" data-email="${escapeHtml(item.email)}" type="button" ${disabledAttrs(ownerAccess)}>Remove</button>`,
          ]),
          emptyTitle:"No members",emptyCopy:"Invite collaborators with bounded workspace roles.",
          subtitle:"Backend authorization remains authoritative; disabled controls explain the role boundary before a 403.",
        })}
        ${tablePanel({
          title:"Pending & historical invites", headers:["Email","Role","Status","Created","Expires"],
          rows:invites.map((item)=>[escapeHtml(item.email),chip(item.role),chip(item.status),escapeHtml(fmtDate(item.createdAt)),escapeHtml(fmtDate(item.expiresAt))]),
          emptyTitle:"No invites",emptyCopy:"New invite tokens are shown only once at creation.",
        })}
        ${tablePanel({
          title:"API keys", headers:["Name","Prefix","Scopes","Rate limit","Last used","Expires","State","Control"],
          rows:keys.map((item)=>[
            escapeHtml(item.name),`<code>${escapeHtml(item.key_prefix)}</code>`,escapeHtml((item.scopes||[]).join(", ")),
            escapeHtml(item.rate_limit_per_hour),escapeHtml(fmtRelative(item.last_used_at)),escapeHtml(fmtDate(item.expires_at)),
            chip(item.revoked_at ? "REVOKED" : "ACTIVE"),
            item.revoked_at ? "—" : `<button class="button danger small key-revoke" data-key-id="${item.id}" type="button" ${disabledAttrs(adminAccess)}>Revoke</button>`,
          ]),
          emptyTitle:"No API keys",emptyCopy:"Create a scoped key for trusted automation. The secret is shown once.",
        })}
        ${tablePanel({
          title:"Your sessions", headers:["State","Session","Client fingerprint","Created","Last seen","Expires","Control"],
          rows:sessions.map((item)=>[
            chip(item.id===currentSessionId ? "CURRENT" : item.status),
            `<code>${escapeHtml(item.id.slice(0,8))}…</code>`,escapeHtml(item.userAgentFingerprint||"—"),escapeHtml(fmtDate(item.createdAt)),
            escapeHtml(fmtRelative(item.lastSeenAt)),escapeHtml(fmtDate(item.expiresAt)),
            item.id===currentSessionId ? "Use Sign out" : item.status==="ACTIVE" ? `<button class="button danger small session-revoke" data-session-id="${item.id}" type="button">Revoke</button>` : "—",
          ]),
          emptyTitle:"No sessions",emptyCopy:"Active account sessions appear here without exposing bearer tokens.",
        })}
      </div>
    </div>`;

  $("#workspace-invite")?.addEventListener("click", openInviteForm);
  $("#workspace-key")?.addEventListener("click", openApiKeyForm);

  $$(".member-role").forEach((select) => select.addEventListener("change", async () => {
    const previous = members.find((item)=>item.id===select.dataset.userId)?.role;
    select.disabled = true;
    try {
      await api(`/v1/platform/workspaces/${wid}/members/${select.dataset.userId}/role`, {
        method:"POST",body:JSON.stringify({role:select.value}),
      });
      toast("Member role updated");
      document.dispatchEvent(new CustomEvent("mecord:refresh"));
    } catch (error) {
      select.value = previous;
      select.disabled = false;
      toast(error.message,true);
    }
  }));

  $$(".member-remove").forEach((button)=>button.addEventListener("click",()=>confirmDecision({
    title:"Remove workspace member",
    kicker:"ACCESS REVOCATION",
    copy:`Remove ${button.dataset.email} from this workspace. Their membership-based access ends immediately.`,
    confirmLabel:"Remove member",danger:true,
    onConfirm:async()=>{
      await api(`/v1/platform/workspaces/${wid}/members/${button.dataset.userId}`,{method:"DELETE"});
      document.dispatchEvent(new CustomEvent("mecord:refresh"));
    },
  })));

  $$(".key-revoke").forEach((button)=>button.addEventListener("click",()=>revokeApiKey(button.dataset.keyId).catch((e)=>toast(e.message,true))));

  $$(".session-revoke").forEach((button)=>button.addEventListener("click",()=>confirmDecision({
    title:"Revoke session",kicker:"ACCOUNT SECURITY",
    copy:"This signs that session out. The current browser session is not affected.",
    confirmLabel:"Revoke session",danger:true,
    onConfirm:async()=>{
      await api(`/v1/platform/sessions/${button.dataset.sessionId}/revoke`,{method:"POST",body:"{}"});
      document.dispatchEvent(new CustomEvent("mecord:refresh"));
    },
  })));

  setPageMeta(`${members.length} members · ${keys.filter(k=>!k.revoked_at).length} active API keys`);
}

async function renderBilling({ content, signal, wid, workspace, section }) {
  const { data, errors } = await settleRequests({
    subscription: api(`/v1/platform/workspaces/${wid}/subscription`, { signal, cacheMs: 4500 }),
    onboarding: api(`/v1/platform/workspaces/${wid}/onboarding`, { signal, cacheMs: 5000 }),
  });
  if (signal.aborted) return;
  const subscription = data.subscription || {};
  state.subscription = subscription;
  const ownerAccess = permission("OWNER", { billingRecovery: true });
  const plan = subscription.subscription?.plan || subscription.workspace?.plan || workspace?.plan || "—";
  const status = subscription.subscription?.status || subscription.workspace?.subscriptionStatus || "—";

  content.innerHTML = `
    ${partialBanner(errors)}
    ${entityHeader({eyebrow:"WORKSPACE",title:"Billing & usage",subtitle:workspace?.name||"Workspace",badges:[plan,status]})}
    <div class="workspace-sections">
      ${workspaceSubnav(section)}
      <div class="stack">
        <div class="metrics">
          ${metric("Plan",plan,status)}
          ${metric("Members",subscription.counts?.members||0,`limit ${subscription.limits?.members??"∞"}`)}
          ${metric("Targets",subscription.counts?.targets||0,`limit ${subscription.limits?.targets??"∞"}`)}
          ${metric("Jobs this month",subscription.usage?.jobs_created||0,`limit ${subscription.limits?.jobsPerMonth??"∞"}`)}
        </div>
        ${panel("Subscription",`<div class="panel-body">
          <div class="detail-grid">
            ${detail("Status",status)}${detail("Plan",plan)}
            ${detail("Trial ends",fmtDate(subscription.subscription?.trial_ends_at))}
            ${detail("Seats",subscription.subscription?.seats??subscription.counts?.members??"—")}
          </div>
          <div class="filters" style="margin-top:12px">
            <button id="billing-team" class="button small" type="button" ${disabledAttrs(ownerAccess)}>Team</button>
            <button id="billing-business" class="button primary small" type="button" ${disabledAttrs(ownerAccess)}>Business</button>
            <button id="billing-portal" class="button small" type="button" ${disabledAttrs(ownerAccess)}>Customer portal</button>
          </div>
          <p class="muted" style="margin:10px 0 0">Checkout and the Customer Portal are hosted by Stripe. Card data does not pass through Mecordxn8n.</p>
        </div>`,{badge:status})}
        ${panel("Usage boundaries",`<div class="panel-body detail-grid">
          ${detail("API keys",subscription.counts?.apiKeys??"—")}${detail("API-key limit",subscription.limits?.apiKeys??"∞")}
          ${detail("Integrations",subscription.counts?.integrations??"—")}${detail("Integration limit",subscription.limits?.integrations??"∞")}
          ${detail("Storage / retention",`${subscription.workspace?.retentionDays??"—"} days`)}${detail("Onboarding",data.onboarding?.status||"—")}
        </div>`)}
      </div>
    </div>`;

  $("#billing-team")?.addEventListener("click",()=>openBilling("TEAM").catch((e)=>toast(e.message,true)));
  $("#billing-business")?.addEventListener("click",()=>openBilling("BUSINESS").catch((e)=>toast(e.message,true)));
  $("#billing-portal")?.addEventListener("click",()=>openBillingPortal().catch((e)=>toast(e.message,true)));
  setPageMeta("Billing remains reachable even when operational writes are subscription-blocked");
}

async function renderAudit({ content, signal, wid, workspace, section }) {
  const { data, errors } = await settleRequests({
    audit: api(`/v1/platform/workspaces/${wid}/audit?limit=300`, { signal, cacheMs: 3500 }),
    subscription: api(`/v1/platform/workspaces/${wid}/subscription`, { signal, cacheMs: 5000 }),
  });
  if (signal.aborted) return;
  const events = data.audit?.events || [];
  const ownerAccess = permission("OWNER");
  const retentionDays = data.subscription?.workspace?.retentionDays || 90;

  content.innerHTML = `
    ${partialBanner(errors)}
    ${entityHeader({eyebrow:"WORKSPACE",title:"Audit & retention",subtitle:workspace?.name||"Workspace",badges:[`${retentionDays}D RETENTION`]})}
    <div class="workspace-sections">
      ${workspaceSubnav(section)}
      <div class="stack">
        ${tablePanel({
          title:"Audit timeline",headers:["Event","Target","Job","Time"],
          rows:events.map((item)=>[`<span class="primary-text">${escapeHtml(item.event_type)}</span>`,escapeHtml(item.target_id||"—"),escapeHtml(item.job_id||"—"),escapeHtml(fmtDate(item.created_at))]),
          emptyTitle:"No audit events",emptyCopy:"Workspace actions will leave an immutable operational trail.",
          subtitle:"Sensitive payload detail is intentionally not expanded in the default product view.",
        })}
        ${panel("Retention policy",`<div class="panel-body">
          <form id="retention-form" class="filters">
            <label style="min-width:180px">Retention days<input name="retentionDays" type="number" min="7" max="3650" value="${escapeHtml(retentionDays)}" ${disabledAttrs(ownerAccess)}></label>
            <button class="button primary small" type="submit" ${disabledAttrs(ownerAccess)}>Update policy</button>
          </form>
          <p class="muted" style="margin:9px 0 0">Retention changes are owner-only and bounded between 7 and 3650 days.</p>
        </div>`)}
        <section class="danger-zone">
          <p class="eyebrow">DANGER ZONE</p><h2>Delete workspace</h2>
          <p class="muted">Irreversible data deletion requires typing the exact workspace slug. This is the only routine product action using typed confirmation.</p>
          <button id="delete-workspace" class="button danger" type="button" ${disabledAttrs(ownerAccess)}>Delete workspace</button>
        </section>
      </div>
    </div>`;

  $("#retention-form")?.addEventListener("submit",async(event)=>{
    event.preventDefault();
    const form=new FormData(event.currentTarget);
    try{
      await api(`/v1/platform/workspaces/${wid}/retention`,{method:"POST",body:JSON.stringify({retentionDays:Number(form.get("retentionDays"))})});
      toast("Retention policy updated");
      document.dispatchEvent(new CustomEvent("mecord:refresh"));
    }catch(error){toast(error.message,true);}
  });

  $("#delete-workspace")?.addEventListener("click",()=>{
    const slug=workspace?.slug||"";
    openModal("Delete workspace","IRREVERSIBLE DELETION",`
      <p>This permanently deletes <strong>${escapeHtml(workspace?.name||"this workspace")}</strong> and cascades its workspace data according to the database model.</p>
      <label>Type <code>${escapeHtml(slug)}</code> to confirm<input id="workspace-delete-slug" autocomplete="off"></label>
      <div class="form-actions"><button class="button" id="workspace-delete-cancel" type="button">Cancel</button><button class="button danger" id="workspace-delete-confirm" type="button" disabled>Delete permanently</button></div>`);
    const input=$("#workspace-delete-slug"), confirm=$("#workspace-delete-confirm");
    input.addEventListener("input",()=>{confirm.disabled=input.value!==slug;});
    $("#workspace-delete-cancel").addEventListener("click",()=>$("#modal").close());
    confirm.addEventListener("click",async()=>{
      confirm.disabled=true;
      try{
        await api(`/v1/platform/workspaces/${wid}`,{method:"DELETE",body:JSON.stringify({confirmationSlug:slug})});
        sessionStorage.removeItem("mecord_workspace");
        $("#modal").close();
        location.assign("/console/home");
      }catch(error){confirm.disabled=false;toast(error.message,true);}
    });
  });

  setPageMeta(`${events.length} recent audit events`);
}
