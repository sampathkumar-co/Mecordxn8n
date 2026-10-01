import test from "node:test";
import assert from "node:assert/strict";

import { getDependencyHealth } from "../src/platform/dependencies.js";

test("dependency health is disabled unless explicitly enabled", async () => {
  const health = await getDependencyHealth({ env: {} });
  assert.deepEqual(health, {
    enabled: false,
    status: "DISABLED",
    dependencies: {},
  });
});

test("dependency health reports safe reachability without returning credentials or URLs", async () => {
  const requests = [];
  const health = await getDependencyHealth({
    env: {
      DEPENDENCY_HEALTH_ENABLED: "true",
      N8N_HEALTH_URL: "http://n8n:5678/healthz",
      MECORD_HEALTH_URL: "https://mecord.example.test/healthz",
      MECORD_MCP_TOKEN: "dependency-test-token",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), headers: options.headers || {} });
      return { status: 200 };
    },
  });
  assert.equal(health.enabled, true);
  assert.equal(health.status, "HEALTHY");
  assert.equal(health.dependencies.n8n.reachable, true);
  assert.equal(health.dependencies.mecord.reachable, true);
  const serialized = JSON.stringify(health);
  assert.equal(serialized.includes("dependency-test-token"), false);
  assert.equal(serialized.includes("mecord.example.test"), false);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.Authorization, "Bearer dependency-test-token");
});

test("dependency health degrades when one dependency is unreachable", async () => {
  const health = await getDependencyHealth({
    env: {
      DEPENDENCY_HEALTH_ENABLED: "true",
      N8N_HEALTH_URL: "http://n8n:5678/healthz",
      MECORD_HEALTH_URL: "https://mecord.example.test/healthz",
    },
    fetchImpl: async (url) => {
      if (String(url).includes("mecord")) throw new Error("offline");
      return { status: 200 };
    },
  });
  assert.equal(health.status, "ATTENTION");
  assert.equal(health.dependencies.n8n.reachable, true);
  assert.equal(health.dependencies.mecord.reachable, false);
});
