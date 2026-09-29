import { CAPABILITIES } from "../authorization.js";
import { auditBrowserPage } from "./browser-qa.js";
import { completeJob, leaseJob, recordPages } from "./control-client.js";

export async function runSiteDiscoveryOnce({
  controlApiUrl,
  workerToken,
  workerId = "site-discovery-worker",
  audit = auditBrowserPage,
}) {
  const job = await leaseJob({
    controlApiUrl,
    workerToken,
    workerId,
    capabilities: [CAPABILITIES.SITE_DISCOVERY],
    leaseSeconds: 300,
  });
  if (!job) return { state: "IDLE" };

  try {
    const observation = await audit(job.requestedUrl, {
      captureScreenshot: false,
      artifactName: job.id,
    });

    const urls = [
      observation.finalUrl || job.requestedUrl,
      ...(observation.dom?.internalLinks || []),
    ];
    const unique = [...new Set(urls)].slice(0, 100);
    const pages = unique.map((url, index) => ({
      url,
      source: index === 0 ? "seed" : "page-link",
      statusCode: index === 0 ? observation.mainStatus : null,
      title: index === 0 ? observation.title : null,
      metadata: { discoveredFrom: job.requestedUrl },
    }));

    await recordPages({
      controlApiUrl,
      workerToken,
      jobId: job.id,
      workerId,
      pages,
    });

    const completed = await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "SUCCEEDED",
      output: { discoveredPages: pages.length },
    });
    return { state: "PROCESSED", jobId: job.id, pages: pages.length, job: completed };
  } catch (error) {
    await completeJob({
      controlApiUrl,
      workerToken,
      workerId,
      jobId: job.id,
      state: "FAILED",
      error: { code: error.code || "DISCOVERY_FAILED", message: error.message },
    }).catch(() => {});
    throw error;
  }
}
