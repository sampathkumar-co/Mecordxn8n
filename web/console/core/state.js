export const state = {
  token: sessionStorage.getItem("mecord_session") || "",
  me: null,
  workspaceId: sessionStorage.getItem("mecord_workspace") || "",
  subscription: null,
  route: null,
  navEpoch: 0,
  navigationController: null,
  fetchedAt: null,
  cache: new Map(),
  railCollapsed: localStorage.getItem("mecord_rail_collapsed") === "1",
};

export function currentWorkspace() {
  return state.me?.workspaces?.find((item) => item.id === state.workspaceId) || null;
}

export function setToken(token) {
  state.token = token || "";
  if (state.token) sessionStorage.setItem("mecord_session", state.token);
  else sessionStorage.removeItem("mecord_session");
}

export function setWorkspace(id) {
  state.workspaceId = id || "";
  state.subscription = null;
  state.cache.clear();
  if (state.workspaceId) sessionStorage.setItem("mecord_workspace", state.workspaceId);
  else sessionStorage.removeItem("mecord_workspace");
}

export function beginNavigation(route) {
  state.navigationController?.abort();
  state.navigationController = new AbortController();
  state.navEpoch += 1;
  state.route = route;
  return {
    epoch: state.navEpoch,
    signal: state.navigationController.signal,
  };
}

export function isCurrentEpoch(epoch) {
  return epoch === state.navEpoch;
}

export function markFetched() {
  state.fetchedAt = new Date();
}

export function setRailCollapsed(value) {
  state.railCollapsed = Boolean(value);
  localStorage.setItem("mecord_rail_collapsed", state.railCollapsed ? "1" : "0");
}
