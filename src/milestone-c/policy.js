const ALLOWED_CONSENT = new Set(["OPTED_IN", "CLIENT_RELATIONSHIP"]);

const TRANSITIONS = Object.freeze({
  NEW: new Set(["QUALIFIED", "PAUSED", "LOST"]),
  QUALIFIED: new Set(["ENGAGED", "PROPOSAL", "PAUSED", "LOST"]),
  ENGAGED: new Set(["PROPOSAL", "NEGOTIATING", "PAUSED", "LOST"]),
  PROPOSAL: new Set(["NEGOTIATING", "PAUSED", "LOST"]),
  NEGOTIATING: new Set(["PAUSED", "LOST"]),
  PAUSED: new Set(["QUALIFIED", "ENGAGED", "PROPOSAL", "NEGOTIATING", "LOST"]),
  WON: new Set([]),
  LOST: new Set(["QUALIFIED"]),
});

export function contactCanActivate(contact, now = new Date()) {
  if (!contact) return { ok: false, code: "CONTACT_NOT_FOUND" };
  if (!ALLOWED_CONSENT.has(contact.consentState || contact.consent_state)) {
    return { ok: false, code: "CONSENT_REQUIRED" };
  }
  if (contact.suppressedAt || contact.suppressed_at) {
    return { ok: false, code: "CONTACT_SUPPRESSED" };
  }
  const expiry = contact.consentExpiresAt || contact.consent_expires_at;
  if (expiry && new Date(expiry).getTime() <= now.getTime()) {
    return { ok: false, code: "CONSENT_EXPIRED" };
  }
  return { ok: true, code: "ALLOWED" };
}

export function canTransitionOpportunity(from, to) {
  if (from === to) return true;
  if (to === "WON") return false;
  return TRANSITIONS[from]?.has(to) || false;
}

export function normalizeCurrency(value) {
  const currency = String(value || "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

export function normalizeCommercialChannel(value) {
  const channel = String(value || "").trim().toUpperCase();
  return ["EMAIL", "PHONE", "WHATSAPP", "OTHER"].includes(channel) ? channel : null;
}

export function normalizeConsentState(value) {
  const state = String(value || "").trim().toUpperCase();
  return ["UNKNOWN","OPTED_IN","CLIENT_RELATIONSHIP","OPTED_OUT","DO_NOT_CONTACT"].includes(state)
    ? state
    : null;
}

export function normalizeActionKind(value) {
  const kind = String(value || "").trim().toUpperCase();
  return ["INITIAL_REACHOUT","FOLLOW_UP","PROPOSAL_SHARE","RENEWAL"].includes(kind)
    ? kind
    : null;
}

export function normalizeResponseType(value) {
  const type = String(value || "").trim().toUpperCase();
  return ["REPLIED","INTERESTED","DECLINED","OPTED_OUT"].includes(type) ? type : null;
}

export function normalizeRevenueKind(value) {
  const kind = String(value || "").trim().toUpperCase();
  return ["CONTRACTED","INVOICED","RECEIVED","REFUNDED"].includes(kind) ? kind : null;
}
