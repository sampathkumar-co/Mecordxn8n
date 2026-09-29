import test from "node:test";
import assert from "node:assert/strict";

import { validateProxyDestination } from "../src/workers/safe-egress-proxy.js";

test("safe egress permits public destinations only on web ports", async () => {
  const publicLookup = async () => [
    { address: "93.184.216.34", family: 4 },
  ];

  const destination = await validateProxyDestination(
    "example.com",
    443,
    publicLookup,
  );

  assert.equal(destination.address, "93.184.216.34");
  assert.equal(destination.port, 443);

  await assert.rejects(
    () => validateProxyDestination("example.com", 8080, publicLookup),
    (error) => error.code === "EGRESS_PORT_NOT_ALLOWED",
  );
});

test("safe egress blocks DNS answers containing private addresses", async () => {
  await assert.rejects(
    () =>
      validateProxyDestination("rebinding.example", 443, async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    (error) => error.code === "PUBLIC_ADDRESS_REQUIRED",
  );
});

test("safe egress blocks link-local cloud metadata destinations", async () => {
  await assert.rejects(
    () =>
      validateProxyDestination("metadata.example", 80, async () => [
        { address: "169.254.169.254", family: 4 },
      ]),
    (error) => error.code === "PUBLIC_ADDRESS_REQUIRED",
  );
});
