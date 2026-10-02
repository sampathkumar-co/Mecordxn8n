import { randomUUID } from "node:crypto";

function normalizeOAuth(oauth = {}) {
  const values = {
    tokenUrl: String(oauth.tokenUrl || "").trim(),
    clientId: String(oauth.clientId || "").trim(),
    clientSecret: String(oauth.clientSecret || "").trim(),
    audience: String(oauth.audience || "").trim(),
    scope: String(oauth.scope || "").trim(),
  };
  const credentialFields = [
    values.tokenUrl,
    values.clientId,
    values.clientSecret,
    values.audience,
  ];
  if (!credentialFields.some(Boolean)) return null;
  for (const [name, value] of Object.entries(values)) {
    if (!value) {
      throw new Error(`MECORD OAuth ${name} is required`);
    }
  }

  let tokenUrl;
  try {
    tokenUrl = new URL(values.tokenUrl);
  } catch {
    throw new Error("MECORD_OAUTH_TOKEN_URL must be a valid URL");
  }
  if (tokenUrl.protocol !== "https:") {
    throw new Error("MECORD_OAUTH_TOKEN_URL must use HTTPS");
  }
  return { ...values, tokenUrl: tokenUrl.toString() };
}

export class MecordMcpClient {
  constructor({
    endpoint,
    token,
    oauth,
    fetchImpl = fetch,
    now = () => Date.now(),
  }) {
    if (!endpoint) throw new Error("MECORD_MCP_URL is required");
    this.endpoint = endpoint;
    this.oauth = normalizeOAuth(oauth);
    this.token = this.oauth ? null : String(token || "").trim() || null;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.oauthAccessToken = null;
    this.oauthExpiresAt = 0;
    this.sessionId = null;
    this.nextId = 1;
  }

  async #authorization({ signal } = {}) {
    if (this.token) return `Bearer ${this.token}`;
    if (!this.oauth) return null;

    if (
      this.oauthAccessToken &&
      this.oauthExpiresAt > this.now() + 30_000
    ) {
      return `Bearer ${this.oauthAccessToken}`;
    }

    const form = new URLSearchParams({
      grant_type: "client_credentials",
      scope: this.oauth.scope,
      audience: this.oauth.audience,
    });
    const formEncode = (value) => {
      const encoded = new URLSearchParams({ value }).toString();
      return encoded.slice("value=".length);
    };
    const basic = Buffer.from(
      formEncode(this.oauth.clientId) +
        ":" +
        formEncode(this.oauth.clientSecret),
      "utf8",
    ).toString("base64");
    const response = await this.fetchImpl(this.oauth.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Basic ${basic}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Mecord OAuth token endpoint returned HTTP ${response.status}`);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error("Mecord OAuth token endpoint returned invalid JSON");
    }
    const accessToken = String(payload.access_token || "").trim();
    const expiresIn = Number(payload.expires_in || 300);
    if (!accessToken) {
      throw new Error("Mecord OAuth token endpoint did not return an access token");
    }
    this.oauthAccessToken = accessToken;
    this.oauthExpiresAt =
      this.now() +
      (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 300) * 1000;
    return `Bearer ${accessToken}`;
  }

  async #post(payload, { signal, retryAuth = true } = {}) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const authorization = await this.#authorization({ signal });
    if (authorization) headers.authorization = authorization;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal,
    });

    if (
      response.status === 401 &&
      retryAuth &&
      this.oauth &&
      !this.token
    ) {
      this.oauthAccessToken = null;
      this.oauthExpiresAt = 0;
      return this.#post(payload, { signal, retryAuth: false });
    }
    if (!response.ok) {
      throw new Error(`Mecord MCP returned HTTP ${response.status}`);
    }

    const session = response.headers?.get?.("mcp-session-id");
    if (session) this.sessionId = session;

    const text = await response.text();
    if (!text) return null;

    const jsonLine = text
      .split("\n")
      .map((line) => line.replace(/^data:\s*/, "").trim())
      .find((line) => line.startsWith("{"));

    return JSON.parse(jsonLine || text);
  }

  async initialize({ signal } = {}) {
    if (this.sessionId) return;
    await this.#post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mecordxn8n", version: "0.1.0" },
      },
    }, { signal });
    await this.#post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, { signal });
  }

  async callTool(name, args, { signal } = {}) {
    await this.initialize({ signal });
    const response = await this.#post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }, { signal });

    if (response?.error) {
      throw new Error(response.error.message || "Mecord MCP tool call failed");
    }
    return response?.result ?? response;
  }

  async submitRemediation({
    finding,
    projectRoot,
    repairPatterns = [],
    signal,
  }) {
    const requestId = randomUUID();
    const objective =
      `Diagnose and remediate the verified website defect "${finding.title}" affecting ${finding.affectedUrl}. ` +
      "Inspect the existing project before changes, reuse canonical architecture, make the smallest safe fix, and run available quality gates. " +
      "Previously successful repair patterns may be supplied as non-authoritative hints; verify them against the current project before reuse.";

    const result = await this.callTool(
      process.env.MECORD_MCP_REMEDIATION_TOOL || "operations",
      {
        action: "submit",
        requestId,
        objective,
        successConditions: [
          "The reported defect is reproduced or its root cause is evidenced.",
          "Any source change remains inside the authorized project root.",
          "Relevant tests, lint, or build checks are run when available.",
          "The final result includes evidence sufficient for before/after verification.",
        ],
        prohibitedScope: [
          "Do not access credentials or unrelated files.",
          "Do not operate outside the authorized project root.",
          "Do not contact third parties or perform external side effects.",
        ],
        projectRoot,
        priorRepairPatterns: repairPatterns.slice(0, 5),
        finding: {
          id: finding.id,
          category: finding.category,
          severity: finding.severity,
          affectedUrl: finding.affectedUrl,
          evidence: finding.evidence,
        },
      },
      { signal },
    );

    return { requestId, result };
  }
}
