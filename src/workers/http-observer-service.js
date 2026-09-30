import { runPublicHttpObserverOnce } from "./public-http.js";
import { createTriggeredWorkerService } from "./trigger-service.js";

export function createObserverService({
  controlApiUrl = process.env.MECORDXN8N_CONTROL_API_URL,
  workerToken = process.env.WORKER_TOKEN,
  triggerToken = process.env.WORKER_TRIGGER_TOKEN,
  workerId = process.env.WORKER_ID || "public-http-observer",
} = {}) {
  if (!controlApiUrl) throw new Error("MECORDXN8N_CONTROL_API_URL is required");
  if (!workerToken) throw new Error("WORKER_TOKEN is required");

  return createTriggeredWorkerService({
    triggerToken,
    runOnce: () =>
      runPublicHttpObserverOnce({
        controlApiUrl,
        workerToken,
        workerId,
      }),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.WORKER_PORT || 8090);
  const server = createObserverService();
  server.listen(port, () => {
    console.log(`public HTTP observer listening on :${port}`);
  });
}
