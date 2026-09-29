import { createHash } from "node:crypto";

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function symptomMaterial(finding) {
  return String(
    finding.evidence?.message ||
      finding.evidence?.errorText ||
      finding.title ||
      finding.fingerprint,
  ).slice(0, 1000);
}

function resultShape(result) {
  if (result == null) return { type: "null", keys: [] };
  if (Array.isArray(result)) return { type: "array", keys: [] };
  if (typeof result !== "object") return { type: typeof result, keys: [] };
  return {
    type: "object",
    keys: Object.keys(result).sort().slice(0, 30),
  };
}

export function repairPatternKey(finding) {
  const root = finding.rootCauseKey || finding.category || "unknown";
  return hash(`${root}|${symptomMaterial(finding)}`);
}

export function extractRepairLearning({ finding, remediationResult, outcome }) {
  const shape = resultShape(remediationResult);
  const patternKey = repairPatternKey(finding);

  return {
    patternKey,
    category: finding.category,
    rootCauseKey: finding.rootCauseKey || null,
    // Store only a non-reversible signature. Raw client errors, paths and
    // MCP output must not become cross-client repair memory.
    symptomSignature: `sha256:${hash(symptomMaterial(finding))}`,
    outcome,
    summary:
      outcome === "SUCCESS"
        ? "Authorized remediation completed successfully."
        : outcome === "PARTIAL"
          ? "Authorized remediation produced a partial outcome."
          : "Authorized remediation did not complete successfully.",
    successfulStrategy:
      outcome === "SUCCESS"
        ? {
            source: "verified-remediation",
            resultType: shape.type,
            resultShape: shape.keys,
          }
        : {},
    validationStrategy: {
      verificationStatus: finding.verification?.status || null,
      evidenceBacked: Boolean(finding.verification?.evidence),
    },
    lessons: {
      resultType: shape.type,
      resultShape: shape.keys,
      rawClientDataStored: false,
    },
  };
}
