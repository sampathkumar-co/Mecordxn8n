import { currentWorkspace, state } from "./state.js";

const roleRank = Object.freeze({ VIEWER: 1, OPERATOR: 2, ADMIN: 3, OWNER: 4 });

export function currentRole() {
  if (state.me?.principal?.kind === "API_KEY") return "API_KEY";
  return currentWorkspace()?.role || "VIEWER";
}

export function hasRole(required) {
  const role = currentRole();
  if (role === "API_KEY") return false;
  return (roleRank[role] || 0) >= (roleRank[required] || 0);
}

export function subscriptionWriteState(subscription = state.subscription) {
  const status = String(subscription?.subscription?.status || subscription?.workspace?.subscriptionStatus || "").toUpperCase();
  const trialEnd = subscription?.subscription?.trial_ends_at;
  if (["PAST_DUE", "CANCELLED", "CANCELED", "ENDED"].includes(status)) {
    return { allowed: false, reason: `Workspace writes are blocked while subscription is ${status}.` };
  }
  if (status === "TRIALING" && trialEnd && new Date(trialEnd).getTime() <= Date.now()) {
    return { allowed: false, reason: "The workspace trial has expired. Billing access remains available." };
  }
  return { allowed: true, reason: "" };
}

export function permission(requiredRole, { billingRecovery = false } = {}) {
  if (!hasRole(requiredRole)) {
    return { allowed: false, reason: `${requiredRole} role or higher required.` };
  }
  if (billingRecovery) return { allowed: true, reason: "" };
  return subscriptionWriteState();
}

export function disabledAttrs(result) {
  return result.allowed ? "" : `disabled aria-disabled="true" title="${String(result.reason).replaceAll('"', "&quot;")}"`;
}
