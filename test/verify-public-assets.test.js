import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { verifyPublicAssets } from "../scripts/verify-public-assets.mjs";

const root = process.cwd();
const files = (url) => path.join(root, "web/console", url.pathname === "/console"
  ? "index.html" : decodeURIComponent(url.pathname.slice("/console/".length)));

test("exact production console source passes release asset parity", async () => {
  const result = await verifyPublicAssets("http://127.0.0.1:8080", {
    fetchImpl: async (url) => new Response(await fs.readFile(files(url), "utf8"), { status: 200 }),
  });
  assert.equal(result.ok, true);
  assert.ok(result.checked >= 10);
  assert.deepEqual(result.failures, []);
});

test("stale or missing public assets reject a release", async () => {
  const result = await verifyPublicAssets("https://example.test", {
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("/app.js")) return new Response("outdated code", { status: 200 });
      if (url.pathname.endsWith("/views/targets.js")) return new Response("", { status: 404 });
      return new Response(await fs.readFile(files(url), "utf8"), { status: 200 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 2);
  assert.ok(result.failures.some((item) => item.file === "app.js"));
  assert.ok(result.failures.some((item) => item.file === "views/targets.js"));
});

test("remote HTTP asset checks are refused", async () => {
  await assert.rejects(
    () => verifyPublicAssets("http://example.test"),
    /HTTPS/,
  );
});

test("HTML-only changes cannot be hidden by an otherwise current JS/CSS bundle", async () => {
  const result = await verifyPublicAssets("https://example.test", {
    fetchImpl: async (url) => {
      if (url.pathname === "/console") return new Response("<html>stale markup</html>", { status: 200 });
      return new Response(await fs.readFile(files(url), "utf8"), { status: 200 });
    },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures.map(x => x.file), ["index.html"]);
});
