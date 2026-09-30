const SEVERITY_WEIGHT = {
  INFO: 15,
  LOW: 30,
  MEDIUM: 60,
  HIGH: 85,
};

const CATEGORY_WEIGHT = {
  "browser-runtime": 18,
  "browser-network": 16,
  "browser-rendering": 10,
  "browser-layout": 8,
  "browser-console": 7,
  "http-status": 14,
  "journey": 20,
};

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function inferJourney(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (/checkout|payment|cart|order/.test(path)) return "purchase";
  if (/login|signin|auth|register/.test(path)) return "authentication";
  if (/contact|lead|quote|demo/.test(path)) return "lead-generation";
  if (/search|product|catalog|shop/.test(path)) return "discovery";
  return "general";
}

export function computeFindingIntelligence(finding, verification = null) {
  const severity = SEVERITY_WEIGHT[finding.severity] ?? 20;
  const category = CATEGORY_WEIGHT[finding.category] ?? 6;
  const occurrences = Math.min(Number(finding.occurrences || 1), 10) * 2;
  const confidence = Number(
    verification?.confidence ?? finding.confidence ?? 0.5,
  );
  const verifiedBonus = verification?.status === "VERIFIED" ? 12 : 0;
  const journey = inferJourney(finding.affectedUrl);

  const journeyWeight = {
    purchase: 18,
    authentication: 14,
    "lead-generation": 13,
    discovery: 9,
    general: 4,
  }[journey];

  const businessImpactScore = clamp(
    severity * 0.55 + category + journeyWeight + occurrences,
  );
  const buyerRelevance = clamp(45 + journeyWeight * 2 + verifiedBonus);
  const repairFeasibility = clamp(
    finding.category === "browser-runtime" ? 72 :
      finding.category === "browser-network" ? 80 :
        finding.category === "browser-layout" ? 88 : 82,
  );
  const engineeringEffort = clamp(
    finding.category === "browser-runtime" ? 48 :
      finding.category === "browser-network" ? 35 :
        finding.category === "browser-layout" ? 28 : 32,
    1,
    100,
  );

  const evidenceQuality = clamp(confidence * 100);
  const opportunityScore = clamp(
    (
      businessImpactScore * 0.34 +
      buyerRelevance * 0.22 +
      repairFeasibility * 0.18 +
      evidenceQuality * 0.18 +
      (100 - engineeringEffort) * 0.08
    ),
  );

  const impactTier =
    businessImpactScore >= 70 ? "HIGH" :
      businessImpactScore >= 40 ? "MEDIUM" : "LOW";

  return {
    businessImpactScore,
    buyerRelevance,
    repairFeasibility,
    engineeringEffort,
    opportunityScore,
    impactTier,
    affectedJourney: journey,
    rationale:
      `Verified evidence is scored as a ${impactTier.toLowerCase()} business-impact issue in the ${journey} journey. ` +
      "The score is directional and does not assume access to private revenue or conversion data.",
    inputs: {
      severity: finding.severity,
      category: finding.category,
      occurrences: finding.occurrences,
      evidenceConfidence: confidence,
      verificationStatus: verification?.status || null,
    },
  };
}
