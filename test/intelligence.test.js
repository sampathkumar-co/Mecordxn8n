import test from "node:test";
import assert from "node:assert/strict";

import { computeFindingIntelligence } from "../src/milestone-a/intelligence.js";

test("verified purchase-flow defects score above equivalent general-page defects", () => {
  const base = {
    severity: "MEDIUM",
    category: "browser-network",
    confidence: 0.98,
    occurrences: 2,
  };

  const purchase = computeFindingIntelligence(
    { ...base, affectedUrl: "https://example.com/checkout" },
    { status: "VERIFIED", confidence: 1 },
  );
  const general = computeFindingIntelligence(
    { ...base, affectedUrl: "https://example.com/about" },
    { status: "VERIFIED", confidence: 1 },
  );

  assert.ok(purchase.businessImpactScore > general.businessImpactScore);
  assert.ok(purchase.opportunityScore >= general.opportunityScore);
  assert.equal(purchase.affectedJourney, "purchase");
});

test("scores remain bounded and explicitly directional", () => {
  const result = computeFindingIntelligence(
    {
      severity: "HIGH",
      category: "journey",
      confidence: 1,
      occurrences: 99,
      affectedUrl: "https://example.com/payment",
    },
    { status: "VERIFIED", confidence: 1 },
  );

  assert.ok(result.opportunityScore >= 0 && result.opportunityScore <= 100);
  assert.match(result.rationale, /directional/i);
});
