export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function fmtShortDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }).format(date);
}

export function fmtRelative(value) {
  if (!value) return "—";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "—";
  const seconds = Math.round((time - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const [unit, divisor] =
    abs < 60 ? ["second", 1] :
    abs < 3600 ? ["minute", 60] :
    abs < 86400 ? ["hour", 3600] :
    ["day", 86400];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
    .format(Math.round(seconds / divisor), unit);
}

export function fmtMoney(minor, currency) {
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

export function fmtNumber(value, maximumFractionDigits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(number);
}

export function hostname(value) {
  try { return new URL(value).hostname; } catch { return String(value || "—"); }
}

export function compactId(value) {
  const text = String(value || "");
  return text.length > 12 ? `${text.slice(0, 8)}…${text.slice(-4)}` : text || "—";
}

export function safeJson(value) {
  try { return JSON.stringify(value ?? {}, null, 2); } catch { return "{}"; }
}

export function remaining(value) {
  if (!value) return "No expiry";
  const ms = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "Unknown";
  if (ms <= 0) return "Expired";
  const hours = Math.ceil(ms / 3600000);
  if (hours < 48) return `${hours}h remaining`;
  return `${Math.ceil(hours / 24)}d remaining`;
}
