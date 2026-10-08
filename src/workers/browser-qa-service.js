import { pathToFileURL } from "node:url";

import { runBrowserQaOnce } from "./browser-qa.js";
import { createTriggeredWorkerService } from "./trigger-service.js";

export function createBrowserQaService({
  controlApiUrl = process.env.MECORDXN8N_CONTROL_API_URL,
  workerToken = process.env.WORKER_TOKEN,
  triggerToken = process.env.WORKER_TRIGGER_TOKEN,
  workerId = process.env.WORKER_ID || "browser-qa-worker",
} = {}) {
  if (!controlApiUrl) throw new Error("MECORDXN8N_CONTROL_API_URL is required");
  if (!workerToken) throw new Error("WORKER_TOKEN is required");

  return createTriggeredWorkerService({
    triggerToken,
    runOnce: () =>
      runBrowserQaOnce({
        controlApiUrl,
        workerToken,
        workerId,
      }),
  });
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const port = Number(process.env.WORKER_PORT || 8091);
  const server = createBrowserQaService();
  server.listen(port, () => {
    console.log(`browser QA worker listening on :${port}`);
  });
}
