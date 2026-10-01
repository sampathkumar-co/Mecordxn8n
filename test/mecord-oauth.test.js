import test from "node:test";
import assert from "node:assert/strict";

import {
  OAuthClientCredentialsTokenProvider,
  mecordOAuthConfigFromEnv,
} from "../src/mcp/oauth-client-credentials.js";

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test("Mecord OAuth provider caches a short-lived bearer token safely", async () => {
  const requests = [];
  let now = 1_000_000;
  const provider = new OAuthClientCredentialsTokenProvider({
    tokenUrl: "https://auth.example.test/token",
    clientId: "machine-client",
    clientSecret: "machine-secret-value",
    scope: "operator:read operator:write",
    resource: "https://mcp.example.test/mcp",
    clock: () => now,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return jsonResponse(200, {
        access_token: "oauth-access-token",
        token_type: "Bearer",
        expires_in: 900,
      });
    },
  });

  assert.equal(await provider.getToken(), "oauth-access-token");
  assert.equal(await provider.getToken(), "oauth-access-token");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, "POST");
  assert.match(requests[0].options.headers.authorization, /^Basic /);
  assert.equal(
    Buffer.from(
      requests[0].options.headers.authorization.slice("Basic ".length),
      "base64",
    ).toString("utf8"),
    "machine-client:machine-secret-value",
  );
  const form = new URLSearchParams(requests[0].options.body);
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("scope"), "operator:read operator:write");
  assert.equal(form.get("resource"), "https://mcp.example.test/mcp");

  now += 880_000;
  assert.equal(await provider.getToken(), "oauth-access-token");
  assert.equal(requests.length, 2);
});

test("Mecord OAuth provider never returns provider error bodies or secrets", async () => {
  const provider = new OAuthClientCredentialsTokenProvider({
    tokenUrl: "https://auth.example.test/token",
    clientId: "machine-client",
    clientSecret: "do-not-leak-this-secret",
    scope: "operator:read",
    resource: "https://mcp.example.test/mcp",
    fetchImpl: async () =>
      jsonResponse(401, {
        error: "invalid_client",
        error_description: "do-not-leak-this-secret",
      }),
  });

  await assert.rejects(
    () => provider.getToken(),
    (error) =>
      error.code === "MECORD_OAUTH_TOKEN_FAILED" &&
      !error.message.includes("do-not-leak-this-secret") &&
      !error.message.includes("invalid_client"),
  );
});

test("Mecord OAuth environment config is explicit and bounded to OAuth mode", () => {
  assert.equal(mecordOAuthConfigFromEnv({}), null);
  assert.equal(
    mecordOAuthConfigFromEnv({
      MECORD_AUTH_MODE: "oauth_client_credentials",
      MECORD_OAUTH_TOKEN_URL: "https://auth.example.test/token",
      MECORD_OAUTH_CLIENT_ID: "client",
      MECORD_OAUTH_CLIENT_SECRET: "secret",
      MECORD_MCP_URL: "https://mcp.example.test/mcp",
    }).resource,
    "https://mcp.example.test/mcp",
  );
});
