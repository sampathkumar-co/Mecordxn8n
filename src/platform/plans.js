export const PLAN_LIMITS = Object.freeze({
  FREE: Object.freeze({
    targets: 3,
    jobsPerMonth: 1000,
    members: 2,
    apiKeys: 2,
    integrations: 2,
  }),
  TEAM: Object.freeze({
    targets: 20,
    jobsPerMonth: 10000,
    members: 10,
    apiKeys: 10,
    integrations: 10,
  }),
  BUSINESS: Object.freeze({
    targets: 100,
    jobsPerMonth: 100000,
    members: 50,
    apiKeys: 50,
    integrations: 50,
  }),
  ENTERPRISE: Object.freeze({
    targets: null,
    jobsPerMonth: null,
    members: null,
    apiKeys: null,
    integrations: null,
  }),
});

export function limitsForPlan(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.FREE;
}
