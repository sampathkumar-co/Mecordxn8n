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
  if (result == null) return { type: "null", keyCount: 0, itemCount: 0 };
  if (Array.isArray(result)) {
    return {
      type: "array",
      keyCount: 0,
      itemCount: Math.min(result.length, 100000),
    };
  }
  if (typeof result !== "object") {
    return { type: typeof result, keyCount: 0, itemCount: 0 };
  }
  return {
    type: "object",
    keyCount: Math.min(Object.keys(result).length, 100000),
    itemCount: 0,
  };
}

function boundedCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(Math.trunc(number), 100000);
}

function safeResultType(value) {
  return [
    "null", "array", "object", "string", "number", "boolean",
    "undefined", "bigint",
  ].includes(value) ? value : "unknown";
}

export function repairPatternKey(finding) {
  const rootCauseClass = String(
    finding.rootCauseKey || finding.category || "unknown",
  ).slice(0, 120);
  return hash(`${rootCauseClass}|${symptomMaterial(finding)}`);
}

export function extractRepairLearning({ finding, remediationResult, outcome }) {
  const shape = resultShape(remediationResult);
  const patternKey = repairPatternKey(finding);

  return {
    patternKey,
    category: String(finding.category || "unknown").slice(0, 120),
    rootCauseKey: finding.rootCauseKey
      ? `sha256:${hash(String(finding.rootCauseKey).slice(0, 1000))}`
      : null,
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
            resultShape: {
              keyCount: shape.keyCount,
              itemCount: shape.itemCount,
            },
          }
        : {},
    validationStrategy: {
      verificationStatus: finding.verification?.status || null,
      evidenceBacked: Boolean(finding.verification?.evidence),
    },
    lessons: {
      resultType: shape.type,
      resultShape: {
        keyCount: shape.keyCount,
        itemCount: shape.itemCount,
      },
      rawClientDataStored: false,
    },
  };
}

export function sanitizeRepairLearning({ finding, learning }) {
  const outcome = ["SUCCESS", "FAILED", "PARTIAL"].includes(learning?.outcome)
    ? learning.outcome
    : null;
  if (!outcome) return null;

  const sourceShape =
    learning?.successfulStrategy?.resultShape ||
    learning?.lessons?.resultShape ||
    {};
  const resultType = safeResultType(
    learning?.successfulStrategy?.resultType ||
      learning?.lessons?.resultType ||
      "unknown",
  );
  const safeShape = {
    keyCount: boundedCount(sourceShape.keyCount),
    itemCount: boundedCount(sourceShape.itemCount),
  };

  return {
    patternKey: repairPatternKey(finding),
    category: String(finding.category || "unknown").slice(0, 120),
    rootCauseKey: finding.rootCauseKey
      ? `sha256:${hash(String(finding.rootCauseKey).slice(0, 1000))}`
      : null,
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
            resultType,
            resultShape: safeShape,
          }
        : {},
    validationStrategy: {
      verificationStatus: finding.verification?.status || null,
      evidenceBacked: Boolean(finding.verification?.evidence),
    },
    lessons: {
      resultType,
      resultShape: safeShape,
      rawClientDataStored: false,
    },
  };
}
