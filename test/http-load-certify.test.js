import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("authenticated HTTP load benchmark rejects public destinations before network access", () => {
  for (const target of ["https://example.com", "http://192.0.2.1:8080", "http://127.0.0.2:8080"]) {
    const result = spawnSync(process.execPath, ["scripts/http-load-certify.mjs"], {
      encoding: "utf8",
      env: { ...process.env, LOAD_TEST_URL: target },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to local nonproduction HTTP servers/);
  }
});
