import { escapeHtml } from "../components/evidence.js";

function chip(value, kind = "") {
  const text = String(value || "UNKNOWN");
  const resolved = kind || (/SUCCESS|SUCCEEDED|VERIFIED|ELIGIBLE|APPROVED/.test(text)
    ? "verified"
    : /FAILED|BLOCKED|DEAD_LETTER|CANCELLED|REJECTED/.test(text)
      ? "severity-high"
      : /PENDING|QUEUED|PARTIAL/.test(text)
        ? "warn"
        : /RUNNING|EXECUTING/.test(text)
          ? "impact"
          : "neutral");
  return '<span class="status-chip ' + resolved + '">' + escapeHtml(text) + '</span>';
}

function stageOf(repair) {
  if (repair.outcome === "SUCCESS") return "SUCCEEDED";
  if (repair.outcome === "PARTIAL") return "PARTIAL";
  if (repair.outcome === "FAILED") return "FAILED";
  if (["FAILED","DEAD_LETTER","CANCELLED"].includes(repair.jobState)) return "FAILED";
  if (repair.requestStatus === "BLOCKED") return "BLOCKED";
  if (repair.jobState === "RUNNING") return "EXECUTING";
  if (repair.jobState === "QUEUED" || repair.requestStatus === "QUEUED") return "QUEUED";
  if (repair.requestStatus === "SUCCEEDED") return "VERIFYING";
  return repair.requestStatus || repair.jobState || "UNKNOWN";
}

function card(title, meta, status, action, extra = "") {
  return '<article class="repair-card">' +
    '<div class="repair-card-head">' + chip(status) + action + '</div>' +
    '<strong>' + escapeHtml(title) + '</strong>' +
    '<small>' + escapeHtml(meta) + '</small>' +
    extra +
    '</article>';
}

export async function renderRepairsView({
  container,
  api,
  workspaceId,
  fmtDate,
  navigate,
}) {
  const data = await api('/v1/platform/workspaces/' + workspaceId + '/repairs?limit=150');
  const eligible = data.eligible || [];
  const approvals = data.approvals || [];
  const repairs = data.repairs || [];
  const active = repairs.filter((item) => ["QUEUED","EXECUTING","VERIFYING"].includes(stageOf(item)));
  const completed = repairs.filter((item) => ["SUCCEEDED","PARTIAL","FAILED","BLOCKED"].includes(stageOf(item)));

  container.innerHTML = `
    <section class="queue-summary">
      <div>
        <p class="eyebrow">PROOF → REPAIR</p>
        <h2>Repair lifecycle</h2>
        <p>Every source change remains tied to verified proof, current authorization, human approval, execution state, and a recorded outcome.</p>
      </div>
      <div class="queue-counts">
        <div><strong>${eligible.length}</strong><span>Eligible</span></div>
        <div><strong>${approvals.length}</strong><span>Awaiting approval</span></div>
        <div><strong>${active.length}</strong><span>In progress</span></div>
      </div>
    </section>

    <div class="repair-board">
      <section class="repair-column">
        <div class="repair-column-head"><span>1</span><strong>Eligible</strong><small>${eligible.length}</small></div>
        <div class="repair-column-list">
          ${eligible.length ? eligible.map((item)=>card(
            item.title,
            (item.organizationName || "Target") + " · " + (item.category || "Finding"),
            "ELIGIBLE",
            '<button class="button text small repair-finding" type="button" data-finding-id="' + escapeHtml(item.id) + '">Review proof →</button>',
            '<div class="repair-card-meta">' + chip(item.severity, item.severity === "HIGH" ? "severity-high" : "neutral") +
              (item.opportunityScore == null ? "" : '<span>' + escapeHtml(Number(item.opportunityScore).toFixed(1)) + '/100 opportunity</span>') +
              '</div>'
          )).join("") : '<div class="repair-empty">No verified finding currently satisfies source-remediation eligibility.</div>'}
        </div>
      </section>

      <section class="repair-column">
        <div class="repair-column-head"><span>2</span><strong>Approval</strong><small>${approvals.length}</small></div>
        <div class="repair-column-list">
          ${approvals.length ? approvals.map((item)=>card(
            item.findingTitle || "Source remediation",
            (item.organizationName || "Target") + " · expires " + fmtDate(item.expiresAt),
            item.status,
            '<button class="button text small repair-approval" type="button" data-approval-id="' + escapeHtml(item.id) + '">Review decision →</button>',
            '<div class="repair-card-meta">' + chip(item.severity || "UNKNOWN", item.severity === "HIGH" ? "severity-high" : "neutral") + '<span>Requested by ' + escapeHtml(item.requestedBy || "unknown") + '</span></div>'
          )).join("") : '<div class="repair-empty">No repair approval is waiting for a human decision.</div>'}
        </div>
      </section>

      <section class="repair-column">
        <div class="repair-column-head"><span>3</span><strong>Execution</strong><small>${active.length}</small></div>
        <div class="repair-column-list">
          ${active.length ? active.map((item)=>card(
            item.findingTitle,
            (item.organizationName || "Target") + " · attempts " + item.attemptCount + "/" + item.maxAttempts,
            stageOf(item),
            '<button class="button text small repair-open" type="button" data-repair-id="' + escapeHtml(item.id) + '">Inspect →</button>',
            item.errorCode ? '<div class="repair-card-error">' + escapeHtml(item.errorCode) + '</div>' : ''
          )).join("") : '<div class="repair-empty">No source repair is currently queued or executing.</div>'}
        </div>
      </section>

      <section class="repair-column">
        <div class="repair-column-head"><span>4</span><strong>Outcome</strong><small>${completed.length}</small></div>
        <div class="repair-column-list">
          ${completed.length ? completed.slice(0,30).map((item)=>card(
            item.findingTitle,
            (item.organizationName || "Target") + " · " + fmtDate(item.completedAt || item.outcomeCreatedAt),
            stageOf(item),
            '<button class="button text small repair-open" type="button" data-repair-id="' + escapeHtml(item.id) + '">View outcome →</button>',
            item.outcomeSummary ? '<p class="repair-outcome-preview">' + escapeHtml(item.outcomeSummary) + '</p>' : (item.errorCode ? '<div class="repair-card-error">' + escapeHtml(item.errorCode) + '</div>' : '')
          )).join("") : '<div class="repair-empty">Completed repair outcomes will appear here.</div>'}
        </div>
      </section>
    </div>
  `;

  container.querySelectorAll(".repair-finding").forEach((button) => {
    button.addEventListener("click", () => navigate('/console/findings/' + button.dataset.findingId));
  });
  container.querySelectorAll(".repair-approval").forEach((button) => {
    button.addEventListener("click", () => navigate('/console/approvals/' + button.dataset.approvalId));
  });
  container.querySelectorAll(".repair-open").forEach((button) => {
    button.addEventListener("click", () => navigate('/console/repairs/' + button.dataset.repairId));
  });
}
