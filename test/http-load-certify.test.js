import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

test("authenticated HTTP load benchmark rejects public destinations before network access", () => {
  for (const target of ["https://example.com", "http://192.0.2.1:8080", "http://127.0.0.2:8080"]) {
    const result = spawnSync(process.execPath, ["scripts/http-load-certify.mjs"], {
      encoding: "utf8", env: { ...process.env, LOAD_TEST_URL: target },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to local nonproduction HTTP servers/);
  }
});

test("IPv6 loopback address passes the destination guard", () => {
  const result = spawnSync(process.execPath, ["scripts/http-load-certify.mjs"], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, LOAD_TEST_URL: "http://[::1]:1" },
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stderr, /restricted to local nonproduction HTTP servers/);
});

async function localServer(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, origin: "http://127.0.0.1:" + server.address().port };
}

async function runBenchmark(base) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/http-load-certify.mjs"], {
      env: { ...process.env, LOAD_TEST_URL: base, LOAD_DURATION_MS: "3000", LOAD_CONCURRENCY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8").on("data", chunk => stderr += chunk);
    child.stdout.setEncoding("utf8").on("data", chunk => stdout += chunk);
    child.once("error", reject);
    child.once("close", code => resolve({ code, stderr, stdout }));
  });
}

test("signup redirects are rejected without contacting another server", async () => {
  let redirectedRequests = 0;
  const second = await localServer((req, res) => {
    redirectedRequests += 1;
    res.writeHead(201, {"content-type":"application/json"});
    res.end(JSON.stringify({token:"dummy",workspace:{id:"workspace"}}));
  });
  const first = await localServer((req, res) => {
    res.writeHead(307, {location:second.origin + "/v1/platform/auth/signup"});
    res.end();
  });
  try {
    const result = await runBenchmark(first.origin);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /signup failed with HTTP 307/);
    assert.equal(redirectedRequests, 0);
  } finally {
    await Promise.all([new Promise(r=>first.server.close(r)),new Promise(r=>second.server.close(r))]);
  }
});

test("authenticated GET redirects are not followed and fail the benchmark", async () => {
  let redirectedRequests = 0;
  const second = await localServer((req, res) => {
    redirectedRequests += 1;
    res.writeHead(200, {"content-type":"application/json"});
    res.end("{}");
  });
  const first = await localServer((req, res) => {
    if (req.method === "POST") {
      res.writeHead(201, {"content-type":"application/json"});
      res.end(JSON.stringify({token:"dummy",workspace:{id:"12345678-1234-1234-1234-123456789abc"}}));
      return;
    }
    res.writeHead(307, {location:second.origin + "/onboarding"});
    res.end();
  });
  try {
    const result = await runBenchmark(first.origin);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /"307":/);
    assert.equal(redirectedRequests, 0);
  } finally {
    await Promise.all([new Promise(r=>first.server.close(r)),new Promise(r=>second.server.close(r))]);
  }
});
