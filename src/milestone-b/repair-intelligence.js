import { createHash } from "node:crypto";

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function repairPatternKey(finding) {
  const root = finding.rootCauseKey || finding.category || "unknown";
  const signature =
    finding.evidence?.message ||
    finding.evidence?.errorText ||
    finding.title ||
    finding.fingerprint;
  return hash(`${root}|${String(signature).slice(0, 500)}`);
}

export function extractRepairLearning({ finding, remediationResult, outcome }) {
  const result = remediationResult || {};
  const serialized = JSON.stringify(result).slice(0, 4000);

  return {
    patternKey: repairPatternKey(finding),
    category: finding.category,
    rootCauseKey: finding.rootCauseKey || null,
    symptomSignature: String(
      finding.evidence?.message ||
        finding.evidence?.errorText ||
        finding.title ||
        finding.fingerprint,
    ).slice(0, 1000),
    outcome,
    summary:
      outcome === "SUCCESS"
        ? "Authorized remediation completed successfully."
        : outcome === "PARTIAL"
          ? "Authorized remediation produced a partial outcome."
          : "Authorized remediation did not complete successfully.",
    successfulStrategy:
      outcome === "SUCCESS"
        ? { mcpResult: serialized }
        : {},
    validationStrategy: {
      verifiedFindingId: finding.id,
      verificationStatus: finding.verification?.status || null,
    },
    lessons: {
      resultPreview: serialized,
    },
  };
}
