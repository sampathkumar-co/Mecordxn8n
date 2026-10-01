import { createHash } from "node:crypto";

import { CAPABILITIES } from "../authorization.js";
import { auditBrowserPage } from "./browser-qa.js";
import {
  completeJob,
  leaseJob,
  recordFinding,
  recordJourneyRun,
  uploadEvidenceArtifact,
} from "./control-client.js";

function fingerprint(parts) {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

function resolveStep(seed, step) {
  const url = new URL(step.url || step.path || "/", seed);
  const origin = new URL(seed).origin;
  if (url.origin !== origin) {
    const error = new Error("journey step is outside the authorized origin");
    error.code = "JOURNEY_STEP_OUT_OF_SCOPE";
    throw error;
  }
  return url.toString();
}

export async function runJourneyQaOnce({
  controlApiUrl,
  workerToken,
  workerId = "journey-qa-worker",
  audit = auditBrowserPage,
}) {
  const job = await leaseJob({
    controlApiUrl,
    workerToken,
    workerId,
    capabilities: [CAPABILITIES.JOURNEY_QA],
    leaseSeconds: 300,
  });
  if (!job) return { state: "IDLE" };

  const name = String(job.input?.name || "read-only journey").slice(0, 120);
  const rawSteps = Array.isArray(job.input?.steps) ? job.input.steps.slice(0, 20) : [];
  if (rawSteps.length === 0) {
    throw Object.assign(new Error("journey requires at least one step"), {
      code: "JOURNEY_STEPS_REQUIRED",
    });
  }

  try {
    const results = [];
    let failed = false;

    for (const rawStep of rawSteps) {
      const url = resolveStep(job.requestedUrl, rawStep);
      const observation = await audit(url, {
        viewport: rawStep.viewport === "mobile" ? "mobile" : "desktop",
        artifactName: `${job.id}-journey-${results.length + 1}`,
      });
      if (observation.artifact) {
        observation.artifact = await uploadEvidenceArtifact({
          controlApiUrl,
          workerToken,
          workerId,
          jobId: job.id,
          artifact: observation.artifact,
        });
      }

      const titleExpected = rawStep.expectTitleIncludes
        ? String(rawStep.expectTitleIncludes)
        : null;
      const titlePassed =
        !titleExpected ||
        String(observation.title || "").toLowerCase().includes(titleExpected.toLowerCase());
      const statusPassed =
        observation.mainStatus != null &&
        observation.mainStatus >= 200 &&
        observation.mainStatus < 400;
      const passed = titlePassed && statusPassed;
      if (!passed) failed = true;

      results.push({
        url,
        passed,
        status: observation.mainStatus,
        title: observation.title,
        titleExpected,
        artifact: observation.artifact || null,
      });
    }

    const state = failed ? "FAILED" : "PASSED";
    await recordJourneyRun({
      controlApiUrl,
      workerToken,
      jobId: job.id,
      workerId,
      name,
      state,
      steps: results,
      evidence: { readOnly: true },
    });

    if (failed) {
      const failing = results.filter((item) => !item.passed);
      await recordFinding({
        controlApiUrl,
        workerToken,
        workerId,
        jobId: job.id,
        finding: {
          fingerprint: fingerprint([
            "journey",
            new URL(job.requestedUrl).hostname,
            name,
            JSON.stringify(failing.map((item) => [item.url, item.status, item.titleExpected])),
          ]),
          category: "journey",
          title: `Read-only user journey failed: ${name}`,
          severity: "MEDIUM",
          confidence: 0.95,
          affectedUrl: failing[0]?.url || job.requestedUrl,
          evidence: { name, failingSteps: failing },
        },
      });
    }

    const completed = await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "SUCCEEDED",
      output: { name, journeyState: state, steps: results },
    });
    return { state: "PROCESSED", jobId: job.id, journeyState: state, job: completed };
  } catch (error) {
    await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "FAILED",
      error: { code: error.code || "JOURNEY_FAILED", message: error.message },
    }).catch(() => {});
    throw error;
  }
}
