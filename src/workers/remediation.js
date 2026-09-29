import { CAPABILITIES } from "../authorization.js";
import { MecordMcpClient } from "../mcp/mecord-client.js";
import { extractRepairLearning } from "../milestone-b/repair-intelligence.js";
import {
  completeJob,
  getFindingContext,
  getRepairPatterns,
  heartbeatJob,
  leaseJob,
  recordRemediationResult,
  recordRepairOutcome,
} from "./control-client.js";

export async function runRemediationOnce({
  controlApiUrl,
  workerToken,
  workerId = "mecord-remediation-worker",
  clientFactory,
}) {
  const job = await leaseJob({
    controlApiUrl,
    workerToken,
    workerId,
    capabilities: [CAPABILITIES.SOURCE_REMEDIATION],
    leaseSeconds: 300,
  });
  if (!job) return { state: "IDLE" };

  let finding = null;
  let heartbeatTimer = null;

  try {
    finding = await getFindingContext({
      controlApiUrl,
      workerToken,
      findingId: job.input?.findingId,
    });
    if (!finding) {
      throw Object.assign(new Error("finding not found"), {
        code: "FINDING_NOT_FOUND",
      });
    }
    if (finding.verification?.status !== "VERIFIED") {
      throw Object.assign(
        new Error("remediation requires a verified finding"),
        { code: "FINDING_NOT_VERIFIED" },
      );
    }
    if (!job.input?.approvalId) {
      throw Object.assign(
        new Error("remediation job is missing a human approval reference"),
        { code: "APPROVAL_REQUIRED" },
      );
    }

    const patternResponse = await getRepairPatterns({
      controlApiUrl,
      workerToken,
      category: finding.category,
      limit: 5,
    }).catch(() => ({ patterns: [] }));

    const client =
      clientFactory?.() ||
      new MecordMcpClient({
        endpoint: process.env.MECORD_MCP_URL,
        token: process.env.MECORD_MCP_TOKEN,
      });

    heartbeatTimer = setInterval(() => {
      void heartbeatJob({
        controlApiUrl,
        workerToken,
        jobId: job.id,
        workerId,
        leaseSeconds: 300,
      }).catch(() => {});
    }, 60_000);
    heartbeatTimer.unref?.();

    const handoff = await client.submitRemediation({
      finding,
      projectRoot: job.input?.projectRoot,
      repairPatterns: patternResponse.patterns || [],
    });

    const remediationRecord = await recordRemediationResult({
      controlApiUrl,
      workerToken,
      jobId: job.id,
      workerId,
      status: "SUCCEEDED",
      mcpRequestId: handoff.requestId,
      mcpResult: handoff.result,
    });

    if (remediationRecord?.id) {
      const learning = extractRepairLearning({
        finding,
        remediationResult: handoff.result,
        outcome: "SUCCESS",
      });
      await recordRepairOutcome({
        controlApiUrl,
        workerToken,
        jobId: job.id,
        remediationRequestId: remediationRecord.id,
        findingId: finding.id,
        learning,
        workerId,
      });
    }

    const completed = await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "SUCCEEDED",
      output: {
        findingId: finding.id,
        approvalId: job.input.approvalId,
        mcpRequestId: handoff.requestId,
        repairPatternsConsulted: patternResponse.patterns?.length || 0,
        result: handoff.result,
      },
    });

    return {
      state: "PROCESSED",
      jobId: job.id,
      mcpRequestId: handoff.requestId,
      job: completed,
    };
  } catch (error) {
    const finalAttempt =
      Number(job.attemptCount || 0) >= Number(job.maxAttempts || 3);

    let remediationRecord = null;
    if (finalAttempt) {
      // Record final failure while this worker still owns the live lease.
      remediationRecord = await recordRemediationResult({
        controlApiUrl,
        workerToken,
        jobId: job.id,
        workerId,
        status: "FAILED",
        mcpResult: {
          error: error.message,
          code: error.code || "REMEDIATION_FAILED",
        },
      }).catch(() => null);

      if (finding && remediationRecord?.id) {
        const learning = extractRepairLearning({
          finding,
          remediationResult: remediationRecord.mcp_result,
          outcome: "FAILED",
        });
        await recordRepairOutcome({
          controlApiUrl,
          workerToken,
          jobId: job.id,
          remediationRequestId: remediationRecord.id,
          findingId: finding.id,
          learning,
          workerId,
        }).catch(() => {});
      }
    }

    await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "FAILED",
      error: {
        code: error.code || "REMEDIATION_FAILED",
        message: error.message,
      },
    }).catch(() => null);

    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}
