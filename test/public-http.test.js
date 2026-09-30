import test from "node:test";
import assert from "node:assert/strict";

import {
  findingForObservation,
  isPublicAddress,
  observePublicHttpUrl,
  resolvePublicAddress,
} from "../src/workers/public-http.js";

test("private and reserved addresses are rejected", () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.8",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "::1",
    "fd00::1",
    "fe80::1",
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }

  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("mixed public/private DNS answers fail closed", async () => {
  await assert.rejects(
    () =>
      resolvePublicAddress("example.test", async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    (error) => error.code === "PUBLIC_ADDRESS_REQUIRED",
  );
});

test("non-standard ports are blocked before network access", async () => {
  await assert.rejects(
    () => observePublicHttpUrl("https://example.com:8443/"),
    (error) => error.code === "PORT_NOT_ALLOWED",
  );
});

test("4xx/5xx observations produce deterministic quality findings", () => {
  const observation = {
    url: "https://example.com/missing",
    statusCode: 404,
    latencyMs: 50,
    remoteAddress: "93.184.216.34",
    headers: {},
    redirectFollowed: false,
  };

  const first = findingForObservation(observation);
  const second = findingForObservation(observation);

  assert.equal(first.severity, "LOW");
  assert.equal(first.confidence, 0.99);
  assert.equal(first.fingerprint, second.fingerprint);
});

test("successful observations do not produce findings", () => {
  assert.equal(
    findingForObservation({
      url: "https://example.com/",
      statusCode: 200,
      latencyMs: 30,
      remoteAddress: "93.184.216.34",
      headers: {},
      redirectFollowed: false,
    }),
    null,
  );
});
