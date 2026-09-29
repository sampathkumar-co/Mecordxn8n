import test from "node:test";
import assert from "node:assert/strict";

import {
  canTransitionOpportunity,
  contactCanActivate,
  normalizeActionKind,
  normalizeCommercialChannel,
  normalizeConsentState,
  normalizeCurrency,
  normalizeResponseType,
  normalizeRevenueKind,
} from "../src/milestone-c/policy.js";

test("commercial contact activation requires affirmative current consent", () => {
  assert.deepEqual(
    contactCanActivate({ consentState: "UNKNOWN" }),
    { ok: false, code: "CONSENT_REQUIRED" },
  );
  assert.deepEqual(
    contactCanActivate({ consentState: "OPTED_OUT", suppressedAt: new Date() }),
    { ok: false, code: "CONSENT_REQUIRED" },
  );
  assert.deepEqual(
    contactCanActivate({
      consentState: "OPTED_IN",
      consentExpiresAt: "2020-01-01T00:00:00.000Z",
    }),
    { ok: false, code: "CONSENT_EXPIRED" },
  );
  assert.deepEqual(
    contactCanActivate({
      consentState: "CLIENT_RELATIONSHIP",
      consentExpiresAt: "2099-01-01T00:00:00.000Z",
    }),
    { ok: true, code: "ALLOWED" },
  );
});

test("commercial opportunity transitions cannot fabricate a win", () => {
  assert.equal(canTransitionOpportunity("NEW", "QUALIFIED"), true);
  assert.equal(canTransitionOpportunity("QUALIFIED", "ENGAGED"), true);
  assert.equal(canTransitionOpportunity("ENGAGED", "NEGOTIATING"), true);
  assert.equal(canTransitionOpportunity("NEGOTIATING", "WON"), false);
  assert.equal(canTransitionOpportunity("LOST", "QUALIFIED"), true);
  assert.equal(canTransitionOpportunity("WON", "QUALIFIED"), false);
});

test("commercial enum normalizers are strict", () => {
  assert.equal(normalizeCurrency("inr"), "INR");
  assert.equal(normalizeCurrency("US"), null);
  assert.equal(normalizeCommercialChannel("email"), "EMAIL");
  assert.equal(normalizeCommercialChannel("telegram"), null);
  assert.equal(normalizeConsentState("opted_in"), "OPTED_IN");
  assert.equal(normalizeConsentState("maybe"), null);
  assert.equal(normalizeActionKind("proposal_share"), "PROPOSAL_SHARE");
  assert.equal(normalizeActionKind("spam"), null);
  assert.equal(normalizeResponseType("opted_out"), "OPTED_OUT");
  assert.equal(normalizeRevenueKind("received"), "RECEIVED");
});
