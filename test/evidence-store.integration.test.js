import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CAPABILITIES, authorize } from "../src/authorization.js";
import { verifyEvidenceReference } from "../src/evidence-store.js";
import {
  closePool,
  createAuthorizedJob,
  getCurrentAuthorization,
  leaseNextJob,
} from "../src/repository.js";
import { createServer } from "../src/server.js";

const enabled = Boolean(process.env.DATABASE_URL);
let server;
let baseUrl;
let evidenceDir;

if (enabled) {
  evidenceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mecord-evidence-"));
  process.env.EVIDENCE_STORE_DIR = evidenceDir;
  server = createServer({
    orchestratorToken: "evidence-orchestrator",
    bootstrapToken: "evidence-bootstrap",
    workerCredentials: [
      {
        id: "browser-qa-worker",
        token: "evidence-browser-worker-token",
        capabilities: [CAPABILITIES.BROWSER_QA],
        routeGroup: "PUBLIC_QA",
      },
      {
        id: "finding-verification-worker",
        token: "evidence-verification-worker-token",
        capabilities: [CAPABILITIES.FINDING_VERIFY],
        routeGroup: "VERIFICATION",
      },
    ],
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

after(async () => {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (enabled) await closePool();
  if (evidenceDir) await fs.rm(evidenceDir, { recursive: true, force: true });
  delete process.env.EVIDENCE_STORE_DIR;
});

async function jsonRequest(pathname, { method = "GET", token, body } = {}) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json().catch(() => null),
  };
}

test(
  "leased scoped workers can only persist checksum-verified immutable evidence",
  { skip: !enabled },
  async () => {
    const suffix = randomUUID().slice(0, 8);
    const signup = await jsonRequest("/v1/platform/auth/signup", {
      method: "POST",
      body: {
        email: `evidence-${suffix}@example.test`,
        displayName: "Evidence Owner",
        password: "Evidence-Password-12345",
        workspaceName: `Evidence ${suffix}`,
        workspaceSlug: `evidence-${suffix}`,
      },
    });
    assert.equal(signup.status, 201);

    const target = await jsonRequest(
      `/v1/platform/workspaces/${signup.body.workspace.id}/targets`,
      {
        method: "POST",
        token: signup.body.token,
        body: {
          organizationName: "Evidence Target",
          baseUrl: "https://evidence.example.test/",
          authorization: {
            mode: "PUBLIC_QA_ONLY",
            allowedHosts: ["evidence.example.test"],
            allowedCapabilities: [CAPABILITIES.BROWSER_QA],
          },
        },
      },
    );
    assert.equal(target.status, 201);

    const authorization = await getCurrentAuthorization(target.body.id);
    const decision = authorize({
      authorization,
      requestedCapability: CAPABILITIES.BROWSER_QA,
      requestedUrl: target.body.baseUrl,
    });
    const job = await createAuthorizedJob({
      targetId: target.body.id,
      authorizationId: authorization.id,
      jobType: "evidence-store-test",
      capability: CAPABILITIES.BROWSER_QA,
      requestedUrl: target.body.baseUrl,
      input: {},
      decision,
    });
    const lease = await leaseNextJob({
      workerId: "browser-qa-worker",
      capabilities: [CAPABILITIES.BROWSER_QA],
      leaseSeconds: 120,
    });
    assert.equal(lease.id, job.id);

    const bytes = Buffer.from("immutable-evidence-" + suffix);
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    const wrongChecksum = await fetch(
      baseUrl + `/v1/worker/evidence/${job.id}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer evidence-browser-worker-token",
          "content-type": "image/png",
          "x-worker-id": "browser-qa-worker",
          "x-evidence-sha256": "0".repeat(64),
        },
        body: bytes,
      },
    );
    assert.equal(wrongChecksum.status, 409);
    assert.equal(
      (await wrongChecksum.json()).error,
      "EVIDENCE_CHECKSUM_MISMATCH",
    );

    const wrongWorker = await fetch(
      baseUrl + `/v1/worker/evidence/${job.id}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer evidence-verification-worker-token",
          "content-type": "image/png",
          "x-worker-id": "finding-verification-worker",
          "x-evidence-sha256": sha256,
        },
        body: bytes,
      },
    );
    assert.equal(wrongWorker.status, 409);
    assert.equal(
      (await wrongWorker.json()).error,
      "EVIDENCE_LEASE_REQUIRED",
    );

    const uploaded = await fetch(
      baseUrl + `/v1/worker/evidence/${job.id}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer evidence-browser-worker-token",
          "content-type": "image/png",
          "x-worker-id": "browser-qa-worker",
          "x-evidence-sha256": sha256,
        },
        body: bytes,
      },
    );
    assert.equal(uploaded.status, 201);
    const artifact = await uploaded.json();
    assert.equal(artifact.path, "evidence://sha256/" + sha256);
    assert.equal(artifact.sha256, sha256);
    assert.equal(artifact.byteLength, bytes.length);
    assert.equal(artifact.immutable, true);

    const verified = await verifyEvidenceReference(artifact.path, {
      EVIDENCE_STORE_DIR: evidenceDir,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.sha256, sha256);
    assert.equal(verified.byteLength, bytes.length);

    const duplicate = await fetch(
      baseUrl + `/v1/worker/evidence/${job.id}`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer evidence-browser-worker-token",
          "content-type": "image/png",
          "x-worker-id": "browser-qa-worker",
          "x-evidence-sha256": sha256,
        },
        body: bytes,
      },
    );
    assert.equal(duplicate.status, 201);
    assert.equal((await duplicate.json()).deduplicated, true);
  },
);
