import { CAPABILITIES } from "../authorization.js";
import { MecordMcpClient } from "../mcp/mecord-client.js";
import {
  completeJob,
  getFindingContext,
  leaseJob,
  recordRemediationResult,
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

  try {
    const finding = await getFindingContext({
      controlApiUrl,
      workerToken,
      findingId: job.input?.findingId,
    });
    if (!finding) throw Object.assign(new Error("finding not found"), { code: "FINDING_NOT_FOUND" });
    if (finding.verification?.status !== "VERIFIED") {
      throw Object.assign(new Error("remediation requires a verified finding"), {
        code: "FINDING_NOT_VERIFIED",
      });
    }

    const client =
      clientFactory?.() ||
      new MecordMcpClient({
        endpoint: process.env.MECORD_MCP_URL,
        token: process.env.MECORD_MCP_TOKEN,
      });

    const handoff = await client.submitRemediation({
      finding,
      projectRoot: job.input?.projectRoot,
    });

    await recordRemediationResult({
      controlApiUrl,
      workerToken,
      jobId: job.id,
      workerId,
      status: "SUCCEEDED",
      mcpRequestId: handoff.requestId,
      mcpResult: handoff.result,
    });

    const completed = await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "SUCCEEDED",
      output: { findingId: finding.id, mcpRequestId: handoff.requestId, result: handoff.result },
    });
    return { state: "PROCESSED", jobId: job.id, mcpRequestId: handoff.requestId, job: completed };
  } catch (error) {
    await recordRemediationResult({
      controlApiUrl,
      workerToken,
      jobId: job.id,
      workerId,
      status: "FAILED",
      mcpResult: { error: error.message, code: error.code || "REMEDIATION_FAILED" },
    }).catch(() => {});
    await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "FAILED",
      error: { code: error.code || "REMEDIATION_FAILED", message: error.message },
    }).catch(() => {});
    throw error;
  }
}
