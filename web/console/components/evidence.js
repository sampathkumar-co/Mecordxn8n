const PRIVATE_KEYS = new Set([
  "path",
  "projectRoot",
  "sourcePath",
  "credentials",
  "credential",
  "token",
  "secret",
  "authorization",
]);

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function label(value) {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (match) => match.toUpperCase());
}

function primitive(value) {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "—";
  return String(value);
}

export function renderEvidenceObject(value, { depth = 0 } = {}) {
  if (value == null) {
    return '<div class="evidence-empty">No structured evidence was recorded.</div>';
  }
  if (depth > 3) return '<span class="muted">Additional nested evidence available</span>';

  if (Array.isArray(value)) {
    if (!value.length) return '<div class="evidence-empty">No entries</div>';
    return '<div class="evidence-list">' + value.slice(0, 40).map((item, index) =>
      '<div class="evidence-list-item"><span class="evidence-index">' + (index + 1) + '</span><div>' +
      renderEvidenceObject(item, { depth: depth + 1 }) + '</div></div>'
    ).join("") + '</div>';
  }

  if (typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([key]) => !PRIVATE_KEYS.has(key))
      .slice(0, 60);
    if (!entries.length) return '<div class="evidence-empty">No displayable evidence fields</div>';
    return '<dl class="evidence-grid">' + entries.map(([key, item]) =>
      '<div class="evidence-field"><dt>' + escapeHtml(label(key)) + '</dt><dd>' +
      (item && typeof item === "object"
        ? renderEvidenceObject(item, { depth: depth + 1 })
        : escapeHtml(primitive(item))) +
      '</dd></div>'
    ).join("") + '</dl>';
  }

  return '<span>' + escapeHtml(primitive(value)) + '</span>';
}

export function renderVerificationTimeline(items = [], fmtDate = (value) => value || "—") {
  if (!items.length) {
    return '<div class="evidence-empty">No verification attempts have been recorded.</div>';
  }
  return '<ol class="verification-timeline">' + items.map((item) => {
    const confidence = item.confidence == null ? "—" : Math.round(Number(item.confidence) * 100) + "%";
    return '<li><div class="verification-dot"></div><div class="verification-card">' +
      '<div class="verification-head"><strong>' + escapeHtml(item.status || "UNKNOWN") + '</strong><span>' + escapeHtml(fmtDate(item.created_at)) + '</span></div>' +
      '<div class="verification-stats"><span>' + escapeHtml(item.matched_attempts ?? 0) + '/' + escapeHtml(item.attempts ?? 0) + ' matched</span><span>' + escapeHtml(confidence) + ' confidence</span></div>' +
      renderEvidenceObject(item.evidence) +
      '</div></li>';
  }).join("") + '</ol>';
}

export function renderArtifacts(items = [], fmtDate = (value) => value || "—") {
  if (!items.length) return '<div class="evidence-empty">No artifacts were attached.</div>';
  return '<div class="artifact-list">' + items.map((item) => {
    const hash = item.sha256 ? String(item.sha256).slice(0, 12) + "…" : "—";
    const size = item.byte_length == null ? "—" : new Intl.NumberFormat().format(Number(item.byte_length)) + " B";
    return '<article class="artifact-row">' +
      '<div><strong>' + escapeHtml(item.kind || "ARTIFACT") + '</strong><span>' + escapeHtml(fmtDate(item.created_at)) + '</span></div>' +
      '<div class="artifact-meta"><span>SHA ' + escapeHtml(hash) + '</span><span>' + escapeHtml(size) + '</span></div>' +
      (item.metadata ? '<div class="artifact-details">' + renderEvidenceObject(item.metadata) + '</div>' : "") +
      '</article>';
  }).join("") + '</div>';
}
