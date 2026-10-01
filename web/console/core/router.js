const routes = [
  { name: "home", area: "home", pattern: /^\/console(?:\/home)?\/?$/i },
  { name: "targets", area: "engineering", pattern: /^\/console\/targets\/?$/i },
  { name: "target-detail", area: "engineering", pattern: /^\/console\/targets\/([0-9a-f-]+)\/?$/i, keys: ["id"] },
  { name: "findings", area: "engineering", pattern: /^\/console\/findings\/?$/i },
  { name: "finding-detail", area: "engineering", pattern: /^\/console\/findings\/([0-9a-f-]+)\/?$/i, keys: ["id"] },
  { name: "runs", area: "engineering", pattern: /^\/console\/runs\/?$/i },
  { name: "approvals", area: "repair", pattern: /^\/console\/approvals\/?$/i },
  { name: "approval-detail", area: "repair", pattern: /^\/console\/approvals\/([0-9a-f-]+)\/?$/i, keys: ["id"] },
  { name: "repairs", area: "repair", pattern: /^\/console\/repairs\/?$/i },
  { name: "repair-detail", area: "repair", pattern: /^\/console\/repairs\/([0-9a-f-]+)\/?$/i, keys: ["id"] },
  { name: "revenue", area: "revenue", pattern: /^\/console\/revenue\/?$/i },
  { name: "opportunity-detail", area: "revenue", pattern: /^\/console\/revenue\/([0-9a-f-]+)\/?$/i, keys: ["id"] },
  { name: "integrations", area: "workspace", pattern: /^\/console\/integrations\/?$/i },
  { name: "integration-detail", area: "workspace", pattern: /^\/console\/integrations\/([0-9a-f-]+)\/?$/i, keys: ["id"] },
  { name: "workspace", area: "workspace", pattern: /^\/console\/workspace(?:\/([a-z-]+))?\/?$/i, keys: ["section"] },
  { name: "operator", area: "operator", pattern: /^\/console\/operator\/?$/i },
];

export function parseRoute(pathname = location.pathname) {
  for (const route of routes) {
    const match = pathname.match(route.pattern);
    if (!match) continue;
    const params = {};
    (route.keys || []).forEach((key, index) => { params[key] = match[index + 1] || null; });
    return { ...route, params, pathname };
  }
  return { name: "not-found", area: "home", params: {}, pathname };
}

export function navigate(path, { replace = false } = {}) {
  if (!path.startsWith("/console")) return;
  if (replace) history.replaceState({}, "", path);
  else history.pushState({}, "", path);
  document.dispatchEvent(new CustomEvent("mecord:navigate", { detail: parseRoute(path) }));
}

export function startRouter() {
  addEventListener("popstate", () => {
    document.dispatchEvent(new CustomEvent("mecord:navigate", { detail: parseRoute() }));
  });
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-link]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith("/console")) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
}

export function routeLabel(route) {
  const labels = {
    home: "Home", targets: "Targets", "target-detail": "Target",
    findings: "Findings", "finding-detail": "Finding", runs: "Runs & regressions",
    approvals: "Approval inbox", "approval-detail": "Approval", repairs: "Repair queue",
    "repair-detail": "Repair", revenue: "Opportunities", "opportunity-detail": "Opportunity",
    integrations: "Integrations", "integration-detail": "Integration", workspace: "Workspace",
    operator: "Platform operator", "not-found": "Not found",
  };
  return labels[route.name] || route.name;
}
