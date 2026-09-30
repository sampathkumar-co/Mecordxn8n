import test from "node:test";
import assert from "node:assert/strict";

import {
  AUTHORIZATION_MODES,
  CAPABILITIES,
  AuthorizationError,
  assertAuthorized,
} from "../src/authorization.js";

const NOW = new Date("2026-09-29T04:00:00.000Z");

function expectDenied(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof AuthorizationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("PUBLIC_QA_ONLY permits browser QA on an explicitly scoped host", () => {
  const result = assertAuthorized({
    authorization: {
      mode: AUTHORIZATION_MODES.PUBLIC_QA_ONLY,
      allowedHosts: ["example.com"],
    },
    requestedCapability: CAPABILITIES.BROWSER_QA,
    requestedUrl: "https://example.com/checkout",
    now: NOW,
  });

  assert.equal(result.authorized, true);
  assert.equal(result.host, "example.com");
});

test("PUBLIC_QA_ONLY blocks active security testing", () => {
  expectDenied(
    () =>
      assertAuthorized({
        authorization: {
          mode: AUTHORIZATION_MODES.PUBLIC_QA_ONLY,
          allowedHosts: ["example.com"],
        },
        requestedCapability: CAPABILITIES.SECURITY_ACTIVE,
        requestedUrl: "https://example.com",
        now: NOW,
      }),
    "CAPABILITY_NOT_ALLOWED",
  );
});

test("BUG_BOUNTY requires the requested capability to be explicitly granted", () => {
  expectDenied(
    () =>
      assertAuthorized({
        authorization: {
          mode: AUTHORIZATION_MODES.BUG_BOUNTY,
          allowedHosts: ["scope.example.com"],
          allowedCapabilities: [CAPABILITIES.SECURITY_PASSIVE],
          expiresAt: "2026-10-30T00:00:00.000Z",
        },
        requestedCapability: CAPABILITIES.SECURITY_ACTIVE,
        requestedUrl: "https://scope.example.com",
        now: NOW,
      }),
    "CAPABILITY_NOT_GRANTED",
  );
});

test("BUG_BOUNTY permits an explicitly granted active capability", () => {
  const result = assertAuthorized({
    authorization: {
      mode: AUTHORIZATION_MODES.BUG_BOUNTY,
      allowedHosts: ["scope.example.com"],
      allowedCapabilities: [CAPABILITIES.SECURITY_ACTIVE],
      expiresAt: "2026-10-30T00:00:00.000Z",
    },
    requestedCapability: CAPABILITIES.SECURITY_ACTIVE,
    requestedUrl: "https://scope.example.com/account",
    now: NOW,
  });

  assert.equal(result.authorized, true);
});

test("BUG_BOUNTY cannot grant source remediation", () => {
  expectDenied(
    () =>
      assertAuthorized({
        authorization: {
          mode: AUTHORIZATION_MODES.BUG_BOUNTY,
          allowedHosts: ["scope.example.com"],
          allowedCapabilities: [CAPABILITIES.SOURCE_REMEDIATION],
          expiresAt: "2026-10-30T00:00:00.000Z",
        },
        requestedCapability: CAPABILITIES.SOURCE_REMEDIATION,
        requestedUrl: "https://scope.example.com",
        now: NOW,
      }),
    "SOURCE_ACCESS_REQUIRES_CLIENT_AUTH",
  );
});

test("CLIENT_AUTHORIZED can explicitly grant source remediation", () => {
  const result = assertAuthorized({
    authorization: {
      mode: AUTHORIZATION_MODES.CLIENT_AUTHORIZED,
      allowedHosts: ["client.example.com"],
      allowedCapabilities: [CAPABILITIES.SOURCE_REMEDIATION],
      expiresAt: "2026-10-30T00:00:00.000Z",
    },
    requestedCapability: CAPABILITIES.SOURCE_REMEDIATION,
    requestedUrl: "https://client.example.com",
    now: NOW,
  });

  assert.equal(result.authorized, true);
});

test("an exact host grant does not silently include subdomains", () => {
  expectDenied(
    () =>
      assertAuthorized({
        authorization: {
          mode: AUTHORIZATION_MODES.PUBLIC_QA_ONLY,
          allowedHosts: ["example.com"],
        },
        requestedCapability: CAPABILITIES.BROWSER_QA,
        requestedUrl: "https://shop.example.com",
        now: NOW,
      }),
    "HOST_OUT_OF_SCOPE",
  );
});

test("expired authorization is rejected", () => {
  expectDenied(
    () =>
      assertAuthorized({
        authorization: {
          mode: AUTHORIZATION_MODES.CLIENT_AUTHORIZED,
          allowedHosts: ["client.example.com"],
          allowedCapabilities: [CAPABILITIES.BROWSER_QA],
          expiresAt: "2026-09-28T00:00:00.000Z",
        },
        requestedCapability: CAPABILITIES.BROWSER_QA,
        requestedUrl: "https://client.example.com",
        now: NOW,
      }),
    "AUTHORIZATION_EXPIRED",
  );
});

test("DO_NOT_TEST blocks even benign capabilities", () => {
  expectDenied(
    () =>
      assertAuthorized({
        authorization: {
          mode: AUTHORIZATION_MODES.DO_NOT_TEST,
          allowedHosts: ["example.com"],
        },
        requestedCapability: CAPABILITIES.PUBLIC_HTTP_OBSERVE,
        requestedUrl: "https://example.com",
        now: NOW,
      }),
    "TARGET_BLOCKED",
  );
});
