import { state } from "./state.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function dispatchConnection(status) {
  document.dispatchEvent(new CustomEvent("mecord:connection", { detail: { status } }));
}

function requestSignal(external, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([external, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  external.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

export async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const retryable = method === "GET" || method === "HEAD";
  const attempts = retryable ? 2 : 1;
  const cacheMs = retryable ? Number(options.cacheMs || 0) : 0;
  const cacheKey = `${state.workspaceId}:${method}:${path}`;

  if (cacheMs > 0) {
    const cached = state.cache.get(cacheKey);
    if (cached && Date.now() - cached.time < cacheMs) return cached.value;
  }

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const headers = new Headers(options.headers || {});
    if (
      path === "/v1/platform/auth/login" ||
      path === "/v1/platform/auth/signup" ||
      path === "/v1/platform/auth/accept-invite"
    ) {
      headers.set("X-Mecord-Session-Mode", "cookie");
    }
    if (state.token) headers.set("Authorization", `Bearer ${state.token}`);
    if (!retryable && state.csrfToken) {
      headers.set("X-CSRF-Token", state.csrfToken);
    }
    if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");

    let response;
    try {
      response = await fetch(path, {
        ...options,
        headers,
        credentials: "same-origin",
        signal: requestSignal(options.signal, options.timeoutMs || 15000),
      });
    } catch (error) {
      if (error?.name === "AbortError" && options.signal?.aborted) throw error;
      dispatchConnection("offline");
      if (retryable && attempt + 1 < attempts) {
        await sleep(180 + attempt * 240);
        continue;
      }
      const wrapped = new Error(
        error?.name === "TimeoutError" ? "The Control API did not respond in time." : "Could not reach the Control API.",
      );
      wrapped.code = error?.name === "TimeoutError" ? "REQUEST_TIMEOUT" : "NETWORK_ERROR";
      throw wrapped;
    }

    if ([429, 502, 503, 504].includes(response.status) && retryable && attempt + 1 < attempts) {
      dispatchConnection("degraded");
      await sleep(220 + attempt * 260);
      continue;
    }

    dispatchConnection(response.status >= 500 ? "degraded" : "online");
    const payload = response.status === 204
      ? null
      : await response.json().catch(() => ({ error: "INVALID_RESPONSE" }));

    if (response.status === 401 && !path.includes("/auth/login") && !path.includes("/auth/signup")) {
      document.dispatchEvent(new CustomEvent("mecord:auth-expired"));
      const expired = new Error("Your session has expired.");
      expired.status = 401;
      throw expired;
    }

    if (!response.ok) {
      const error = new Error(payload?.message || payload?.error || "Request failed");
      error.code = payload?.error || "REQUEST_FAILED";
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    if (!retryable) state.cache.clear();
    if (cacheMs > 0) state.cache.set(cacheKey, { value: payload, time: Date.now() });
    return payload;
  }
  throw new Error("Request failed");
}

export async function settleRequests(requests) {
  const entries = Object.entries(requests);
  const settled = await Promise.allSettled(entries.map(([, promise]) => promise));
  const data = {};
  const errors = {};
  settled.forEach((result, index) => {
    const key = entries[index][0];
    if (result.status === "fulfilled") data[key] = result.value;
    else if (result.reason?.name !== "AbortError") errors[key] = result.reason;
  });
  return { data, errors };
}
