import { createTriggeredWorkerService } from "./trigger-service.js";
import { runIntegrationWorkerOnce } from "./integration-worker.js";

const port = Number(process.env.WORKER_PORT || 8096);
const server = createTriggeredWorkerService({
  triggerToken: process.env.WORKER_TRIGGER_TOKEN,
  runOnce: () => runIntegrationWorkerOnce(),
});

server.listen(port, "0.0.0.0", () => {
  console.log(`integration delivery worker listening on :${port}`);
});
