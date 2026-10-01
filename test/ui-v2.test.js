import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { createServer } from "../src/server.js";

const server = createServer({
  orchestratorToken: "ui-v2-orchestrator",
  workerToken: "ui-v2-worker",
  bootstrapToken: "ui-v2-bootstrap",
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

after(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test("Control Center V2 serves deep links through one hardened shell", async () => {
  const routes = [
    "/console/home",
    "/console/targets/11111111-1111-4111-8111-111111111111",
    "/console/findings/22222222-2222-4222-8222-222222222222",
    "/console/approvals/33333333-3333-4333-8333-333333333333",
    "/console/repairs/44444444-4444-4444-8444-444444444444",
    "/console/revenue/55555555-5555-4555-8555-555555555555",
    "/console/workspace/access",
  ];

  for (const route of routes) {
    const response = await fetch(baseUrl + route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get("content-type") || "", /text\/html/);
    assert.match(
      response.headers.get("content-security-policy") || "",
      /object-src 'none'/,
    );
    assert.match(
      response.headers.get("content-security-policy") || "",
      /frame-ancestors 'none'/,
    );
    const html = await response.text();
    assert.match(html, /Problem → Proof → Repair → Revenue/i);
    assert.match(html, /command-palette/);
    assert.match(html, /styles\/tokens\.css/);
  }
});

test("Control Center V2 module assets are served with nosniff and same-origin policy", async () => {
  for (const asset of [
    "/console/app.js",
    "/console/core/router.js",
    "/console/components/actions.js",
    "/console/views/findings.js",
    "/console/styles/views.css",
  ]) {
    const response = await fetch(baseUrl + asset);
    assert.equal(response.status, 200, asset);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.match(
      response.headers.get("cache-control") || "",
      /max-age=300/,
    );
  }
});

test("unknown console file extensions and traversal-like asset paths are not served", async () => {
  const unknown = await fetch(baseUrl + "/console/secrets.env");
  assert.equal(unknown.status, 404);

  const encoded = await fetch(baseUrl + "/console/%2e%2e%2fpackage.json");
  assert.equal(encoded.status, 404);
});

test("Control Center browser routing does not depend on legacy bearer storage", () => {
  const source = fs.readFileSync(path.resolve("web/console/app.js"), "utf8");
  assert.equal(source.includes("if (!state.token || !state.me) return;"), false);
  assert.match(source, /if \(!state\.me\) return;/);
  assert.match(source, /login-mfa-row/);
});

test("Control Center V2 remains CSP-compatible without inline style attributes or nested dialog forms", () => {
  const root = path.resolve("web/console");
  const files = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.isFile() &&
        (entry.name.endsWith(".html") || entry.name.endsWith(".js"))
      ) {
        files.push(full);
      }
    }
  }

  walk(root);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(
      source.includes('style="'),
      false,
      `${path.relative(root, file)} contains an inline style attribute`,
    );
  }

  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.equal(/<form[^>]+method=["']dialog["']/i.test(html), false);
  assert.match(html, /<dialog id="modal" class="modal">\s*<div class="modal-shell">/);
  assert.match(html, /data-close-dialog="modal"/);
});
