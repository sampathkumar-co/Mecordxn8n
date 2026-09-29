const UUID = "[0-9a-f-]{36}";

const routes = [
  [/^\/console\/?$/, () => ({ view: "overview", params: {}, path: "/console/home" })],
  [/^\/console\/home\/?$/, () => ({ view: "overview", params: {}, path: "/console/home" })],
  [/^\/console\/launch\/?$/, () => ({ view: "launch", params: {}, path: "/console/launch" })],
  [/^\/console\/targets\/?$/, () => ({ view: "targets", params: {}, path: "/console/targets" })],
  [new RegExp("^/console/targets/(" + UUID + ")/?$", "i"), (match) => ({ view: "targetDetail", params: { targetId: match[1] }, path: "/console/targets/" + match[1] })],
  [/^\/console\/findings\/?$/, () => ({ view: "findings", params: {}, path: "/console/findings" })],
  [new RegExp("^/console/findings/(" + UUID + ")/?$", "i"), (match) => ({ view: "findingDetail", params: { findingId: match[1] }, path: "/console/findings/" + match[1] })],
  [/^\/console\/approvals\/?$/, () => ({ view: "approvals", params: {}, path: "/console/approvals" })],
  [new RegExp("^/console/approvals/(" + UUID + ")/?$", "i"), (match) => ({ view: "approvalDetail", params: { approvalId: match[1] }, path: "/console/approvals/" + match[1] })],
  [/^\/console\/revenue\/?$/, () => ({ view: "pipeline", params: {}, path: "/console/revenue" })],
  [/^\/console\/runs\/?$/, () => ({ view: "operations", params: {}, path: "/console/runs" })],
  [new RegExp("^/console/runs/(" + UUID + ")/?$", "i"), (match) => ({ view: "runDetail", params: { jobId: match[1] }, path: "/console/runs/" + match[1] })],
  [/^\/console\/integrations\/?$/, () => ({ view: "integrations", params: {}, path: "/console/integrations" })],
  [/^\/console\/workspace\/access\/?$/, () => ({ view: "team", params: {}, path: "/console/workspace/access" })],
  [/^\/console\/workspace\/audit\/?$/, () => ({ view: "audit", params: {}, path: "/console/workspace/audit" })],
  [/^\/console\/operator\/?$/, () => ({ view: "operator", params: {}, path: "/console/operator" })],
];

export const pathForView = Object.freeze({
  overview: "/console/home",
  launch: "/console/launch",
  targets: "/console/targets",
  findings: "/console/findings",
  approvals: "/console/approvals",
  pipeline: "/console/revenue",
  operations: "/console/runs",
  integrations: "/console/integrations",
  team: "/console/workspace/access",
  audit: "/console/workspace/audit",
  operator: "/console/operator",
});

export function parseConsoleRoute(pathname = window.location.pathname) {
  for (const [pattern, build] of routes) {
    const match = pathname.match(pattern);
    if (match) return build(match);
  }
  return { view: "overview", params: {}, path: "/console/home", notFound: true };
}

export function navigateConsole(path, { replace = false } = {}) {
  const route = parseConsoleRoute(path);
  const target = route.notFound ? "/console/home" : path;
  window.history[replace ? "replaceState" : "pushState"]({}, "", target);
  window.dispatchEvent(new CustomEvent("console:navigate", { detail: parseConsoleRoute(target) }));
}

export function findingPath(id) {
  return "/console/findings/" + encodeURIComponent(id);
}
