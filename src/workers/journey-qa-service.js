import { runJourneyQaOnce } from "./journey-qa.js";
import { createTriggeredWorkerService } from "./trigger-service.js";

export function createService({
  controlApiUrl = process.env.MECORDXN8N_CONTROL_API_URL,
  workerToken = process.env.WORKER_TOKEN,
  triggerToken = process.env.WORKER_TRIGGER_TOKEN,
  workerId = process.env.WORKER_ID || "journey-qa-worker",
} = {}) {
  if (!controlApiUrl) throw new Error("MECORDXN8N_CONTROL_API_URL is required");
  if (!workerToken) throw new Error("WORKER_TOKEN is required");

  return createTriggeredWorkerService({
    triggerToken,
    runOnce: () => runJourneyQaOnce({ controlApiUrl, workerToken, workerId }),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.WORKER_PORT || 8093);
  createService().listen(port, () => {
    console.log("journey-qa-worker listening on :" + port);
  });
}
