import { randomUUID } from "node:crypto";

export class MecordMcpClient {
  constructor({ endpoint, token, fetchImpl = fetch }) {
    if (!endpoint) throw new Error("MECORD_MCP_URL is required");
    this.endpoint = endpoint;
    this.token = token || null;
    this.fetchImpl = fetchImpl;
    this.sessionId = null;
    this.nextId = 1;
  }

  async #post(payload) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

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

  async initialize() {
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
    });
    await this.#post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  }

  async callTool(name, args) {
    await this.initialize();
    const response = await this.#post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (response?.error) {
      throw new Error(response.error.message || "Mecord MCP tool call failed");
    }
    return response?.result ?? response;
  }

  async submitRemediation({ finding, projectRoot }) {
    const requestId = randomUUID();
    const objective =
      `Diagnose and remediate the verified website defect "${finding.title}" affecting ${finding.affectedUrl}. ` +
      "Inspect the existing project before changes, reuse canonical architecture, make the smallest safe fix, and run available quality gates.";

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
        finding: {
          id: finding.id,
          category: finding.category,
          severity: finding.severity,
          affectedUrl: finding.affectedUrl,
          evidence: finding.evidence,
        },
      },
    );

    return { requestId, result };
  }
}
