import { CAPABILITIES } from "../authorization.js";
import { computeFindingIntelligence } from "../milestone-a/intelligence.js";
import { auditBrowserPage, buildBrowserFindings } from "./browser-qa.js";
import {
  completeJob,
  getFindingContext,
  leaseJob,
  recordVerification,
  uploadEvidenceArtifact,
} from "./control-client.js";
import { findingForObservation, observePublicHttpUrl } from "./public-http.js";

async function reproduce(finding, jobId, attempt, { browserAudit, httpObserve }) {
  if (finding.category === "http-status") {
    const observation = await httpObserve(finding.affectedUrl);
    const candidate = findingForObservation(observation);
    return {
      matched: candidate?.fingerprint === finding.fingerprint,
      evidence: observation,
      artifact: null,
    };
  }

  const observation = await browserAudit(finding.affectedUrl, {
    viewport: finding.evidence?.viewport === "mobile" ? "mobile" : "desktop",
    artifactName: `${jobId}-verify-${attempt}`,
  });
  const candidates = buildBrowserFindings(observation);
  return {
    matched: candidates.some((candidate) => candidate.fingerprint === finding.fingerprint),
    evidence: {
      finalUrl: observation.finalUrl,
      mainStatus: observation.mainStatus,
      title: observation.title,
      pageErrors: observation.pageErrors,
      consoleErrors: observation.consoleErrors,
      httpErrors: observation.httpErrors,
      requestFailures: observation.requestFailures,
      dom: observation.dom,
    },
    artifact: observation.artifact || null,
  };
}

export async function runFindingVerificationOnce({
  controlApiUrl,
  workerToken,
  workerId = "finding-verification-worker",
  browserAudit = auditBrowserPage,
  httpObserve = observePublicHttpUrl,
}) {
  const job = await leaseJob({
    controlApiUrl,
    workerToken,
    workerId,
    capabilities: [CAPABILITIES.FINDING_VERIFY],
    leaseSeconds: 300,
  });
  if (!job) return { state: "IDLE" };

  try {
    const findingId = job.input?.findingId;
    const finding = await getFindingContext({ controlApiUrl, workerToken, findingId });
    if (!finding) throw Object.assign(new Error("finding not found"), { code: "FINDING_NOT_FOUND" });

    const attempts = Math.min(Math.max(Number(job.input?.attempts || 2), 2), 3);
    const runs = [];
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const run = await reproduce(finding, job.id, attempt, {
        browserAudit,
        httpObserve,
      });
      if (run.artifact) {
        run.artifact = await uploadEvidenceArtifact({
          controlApiUrl,
          workerToken,
          workerId,
          jobId: job.id,
          artifact: run.artifact,
        });
      }
      runs.push(run);
    }

    const matchedAttempts = runs.filter((run) => run.matched).length;
    const status = matchedAttempts === attempts ? "VERIFIED" : "NOT_REPRODUCED";
    const confidence = matchedAttempts / attempts;
    const verificationShape = { status, confidence };
    const intelligence = computeFindingIntelligence(finding, verificationShape);

    await recordVerification({
      controlApiUrl,
      workerToken,
      jobId: job.id,
      workerId,
      findingId,
      status,
      attempts,
      matchedAttempts,
      confidence,
      evidence: {
        runs: runs.map((run) => ({ matched: run.matched, evidence: run.evidence })),
      },
      artifacts: runs
        .map((run) => run.artifact)
        .filter(Boolean)
        .map((artifact) => ({ ...artifact, kind: artifact.type || "screenshot" })),
      intelligence,
    });

    const completed = await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "SUCCEEDED",
      output: { findingId, status, attempts, matchedAttempts, confidence, intelligence },
    });
    return { state: "PROCESSED", jobId: job.id, verificationStatus: status, job: completed };
  } catch (error) {
    await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "FAILED",
      error: { code: error.code || "VERIFICATION_FAILED", message: error.message },
    }).catch(() => {});
    throw error;
  }
}
