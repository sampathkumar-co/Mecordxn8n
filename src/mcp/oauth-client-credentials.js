const MAX_TOKEN_BYTES = 16 * 1024;
const MIN_REFRESH_SKEW_MS = 30_000;

function httpsUrl(input, label) {
  let url;
  try {
    url = new URL(String(input || "").trim());
  } catch {
    throw new Error(label + " must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(label + " must be credential-free HTTPS");
  }
  return url;
}

function bounded(value, label, max = 4096) {
  const text = String(value || "").trim();
  if (!text || Buffer.byteLength(text, "utf8") > max || /[\0\r\n]/.test(text)) {
    throw new Error(label + " is invalid");
  }
  return text;
}

export class OAuthClientCredentialsTokenProvider {
  constructor({
    tokenUrl,
    clientId,
    clientSecret,
    scope,
    resource,
    fetchImpl = fetch,
    clock = () => Date.now(),
  }) {
    this.tokenUrl = httpsUrl(tokenUrl, "MECORD_OAUTH_TOKEN_URL");
    this.clientId = bounded(clientId, "MECORD_OAUTH_CLIENT_ID", 512);
    this.clientSecret = bounded(
      clientSecret,
      "MECORD_OAUTH_CLIENT_SECRET",
      4096,
    );
    this.scope = bounded(scope, "MECORD_OAUTH_SCOPE", 1024);
    this.resource = httpsUrl(resource, "MECORD_OAUTH_RESOURCE").toString();
    this.fetchImpl = fetchImpl;
    this.clock = clock;
    this.cached = null;
    this.inflight = null;
  }

  invalidate() {
    this.cached = null;
  }

  async getToken({ forceRefresh = false, signal } = {}) {
    const now = this.clock();
    if (
      !forceRefresh &&
      this.cached &&
      this.cached.expiresAt - MIN_REFRESH_SKEW_MS > now
    ) {
      return this.cached.token;
    }

    if (!forceRefresh && this.inflight) return await this.inflight;

    const work = this.#fetchToken({ signal });
    this.inflight = work;
    try {
      return await work;
    } finally {
      if (this.inflight === work) this.inflight = null;
    }
  }

  async #fetchToken({ signal } = {}) {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: this.scope,
      resource: this.resource,
    });
    const basic = Buffer.from(
      this.clientId + ":" + this.clientSecret,
      "utf8",
    ).toString("base64");

    const response = await this.fetchImpl(this.tokenUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Basic " + basic,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
      signal: signal || AbortSignal.timeout(10_000),
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = new Error(
        "Mecord OAuth token endpoint returned HTTP " + response.status,
      );
      error.code = "MECORD_OAUTH_TOKEN_FAILED";
      throw error;
    }

    const token = String(payload?.access_token || "");
    if (
      !token ||
      Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES ||
      /[\0\r\n]/.test(token)
    ) {
      const error = new Error("Mecord OAuth access token is invalid");
      error.code = "MECORD_OAUTH_TOKEN_INVALID";
      throw error;
    }
    if (
      payload?.token_type &&
      String(payload.token_type).toLowerCase() !== "bearer"
    ) {
      const error = new Error("Mecord OAuth token type is not Bearer");
      error.code = "MECORD_OAUTH_TOKEN_INVALID";
      throw error;
    }

    const expiresIn = Number(payload?.expires_in || 300);
    if (!Number.isFinite(expiresIn) || expiresIn < 30 || expiresIn > 86_400) {
      const error = new Error("Mecord OAuth token lifetime is invalid");
      error.code = "MECORD_OAUTH_TOKEN_INVALID";
      throw error;
    }
    this.cached = {
      token,
      expiresAt: this.clock() + Math.floor(expiresIn * 1000),
    };
    return token;
  }
}

export function mecordOAuthConfigFromEnv(env = process.env) {
  const mode = String(env.MECORD_AUTH_MODE || "").trim().toLowerCase();
  if (mode !== "oauth_client_credentials") return null;
  return {
    tokenUrl: env.MECORD_OAUTH_TOKEN_URL,
    clientId: env.MECORD_OAUTH_CLIENT_ID,
    clientSecret: env.MECORD_OAUTH_CLIENT_SECRET,
    scope: env.MECORD_OAUTH_SCOPE || "operator:read operator:write",
    resource: env.MECORD_OAUTH_RESOURCE || env.MECORD_MCP_URL,
  };
}
