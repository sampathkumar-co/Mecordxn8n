import { escapeHtml, fmtDate } from "../core/format.js";
import { state } from "../core/state.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let toastTimer;
export function toast(message, isError = false) {
  const node = $("#toast");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("error", isError);
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3200);
}

export function statusTone(value) {
  const text = String(value || "—").toUpperCase();
  if (/FAILED|DEAD|REJECTED|EXPIRED|BLOCKED|HIGH|SUSPENDED|PAST_DUE|CANCEL/.test(text)) return "danger";
  if (/WARN|PENDING|RETRY|MEDIUM|DUE|VERIFYING|QUEUED|TRIAL/.test(text)) return "warn";
  if (/ACTIVE|APPROVED|SUCCEEDED|VERIFIED|HEALTHY|WON|READY|RECEIVED/.test(text)) return "good";
  return "neutral";
}

export function chip(value, extra = "") {
  const text = String(value ?? "—");
  return `<span class="chip ${statusTone(text)} ${escapeHtml(extra)}"><span aria-hidden="true">●</span>${escapeHtml(text)}</span>`;
}

export function metric(label, value, meta = "", badge = "") {
  return `<article class="metric">
    <div class="metric-top"><span class="metric-label">${escapeHtml(label)}</span>${badge ? chip(badge) : ""}</div>
    <div class="metric-value">${escapeHtml(value ?? "—")}</div>
    <div class="metric-meta">${escapeHtml(meta)}</div>
  </article>`;
}

export function detail(label, value, { html = false } = {}) {
  return `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${html ? value : escapeHtml(value ?? "—")}</strong></div>`;
}

export function emptyState(title, copy, action = "") {
  return `<div class="empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(copy)}</span>${action}</div>`;
}

export function errorState(title, error, retryId = "retry-view") {
  return `<div class="panel"><div class="error-state">
    <strong>${escapeHtml(title)}</strong>
    <span>${escapeHtml(error?.message || "Something went wrong.")}</span>
    <button id="${escapeHtml(retryId)}" class="button primary small" type="button">Retry</button>
  </div></div>`;
}

export function loadingView() {
  return `<div class="loading-grid">
    <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>
  </div><div class="skeleton loading-block"></div>`;
}

export function partialBanner(errors) {
  const entries = Object.entries(errors || {});
  if (!entries.length) return "";
  return `<div class="partial-banner" role="status">
    <div><strong>Some live data could not be loaded.</strong><div>${escapeHtml(entries.map(([name]) => name).join(", "))} remains unavailable; available sections are still shown.</div></div>
    <button class="button small" type="button" data-refresh-view>Retry</button>
  </div>`;
}

export function panel(title, body, { badge = "", subtitle = "", actions = "" } = {}) {
  return `<section class="panel">
    <div class="panel-header">
      <div><h2>${escapeHtml(title)}</h2>${subtitle ? `<div class="panel-subtitle">${escapeHtml(subtitle)}</div>` : ""}</div>
      <div class="filters">${badge ? chip(badge) : ""}${actions}</div>
    </div>
    ${body}
  </section>`;
}

export function tablePanel({
  title,
  headers,
  rows,
  emptyTitle = "Nothing here",
  emptyCopy = "No records match this view.",
  subtitle = "",
  actions = "",
}) {
  const body = rows.length
    ? `<div class="table-wrap"><table class="table">
        <thead><tr>${headers.map((h) => `<th scope="col">${escapeHtml(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>`
    : emptyState(emptyTitle, emptyCopy);
  return panel(title, body, { badge: String(rows.length), subtitle, actions });
}

export function entityHeader({ eyebrow = "", title, subtitle = "", badges = [], actions = "" }) {
  return `<header class="entity-header">
    <div>
      ${eyebrow ? `<p class="eyebrow">${escapeHtml(eyebrow)}</p>` : ""}
      <h1>${escapeHtml(title)}</h1>
      ${subtitle ? `<div class="entity-subtitle">${escapeHtml(subtitle)}</div>` : ""}
      ${badges.length ? `<div class="authorization-summary mt-8">${badges.map((b) => chip(b)).join("")}</div>` : ""}
    </div>
    <div class="entity-actions">${actions}</div>
  </header>`;
}

export function tabs(items, active) {
  return `<div class="tabs" role="tablist">${items.map((item) =>
    `<button class="tab ${item.id === active ? "active" : ""}" data-tab="${escapeHtml(item.id)}" type="button" role="tab" aria-selected="${item.id === active ? "true" : "false"}">${escapeHtml(item.label)}${item.count != null ? ` <span class="count-badge">${escapeHtml(item.count)}</span>` : ""}</button>`
  ).join("")}</div>`;
}

export function setPageMeta(text = "") {
  const node = $("#page-meta");
  if (!node) return;
  const fetched = state.fetchedAt ? `Updated ${fmtDate(state.fetchedAt)}` : "";
  node.textContent = [text, fetched].filter(Boolean).join(" · ");
}

export function humanError(error) {
  const code = error?.code ? ` (${error.code})` : "";
  return `${error?.message || "Request failed"}${code}`;
}

export function recoveryBlock(error, {
  impact = "The requested operation did not complete.",
  next = "Review the current state and retry only when safe.",
} = {}) {
  return `<div class="recovery-block" role="alert">
    <div><strong>What failed</strong><div>${escapeHtml(humanError(error))}</div></div>
    <div><strong>Impact</strong><div>${escapeHtml(impact)}</div></div>
    <div><strong>What you can do</strong><div>${escapeHtml(next)}</div></div>
  </div>`;
}
