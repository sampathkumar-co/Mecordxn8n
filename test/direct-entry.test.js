import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const entrypoints = [
  "src/server.js",
  "src/workers/http-observer-service.js",
  "src/workers/browser-qa-service.js",
  "src/workers/site-discovery-service.js",
  "src/workers/journey-qa-service.js",
  "src/workers/finding-verification-service.js",
  "src/workers/remediation-service.js",
];

test("direct-run entrypoints normalize argv paths cross-platform", () => {
  for (const relative of entrypoints) {
    const source = fs.readFileSync(path.resolve(relative), "utf8");
    assert.equal(
      source.includes('file://${process.argv[1]}'),
      false,
      relative + " still uses a platform-specific file URL comparison",
    );
    assert.match(source, /pathToFileURL\(process\.argv\[1\]\)\.href/, relative);
  }
});
