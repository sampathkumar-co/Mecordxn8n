import { deliverIntegrationEvent } from "../integrations/delivery.js";
import { workerApiRequest } from "./control-client.js";

export async function runIntegrationWorkerOnce({
  controlApiUrl = process.env.MECORDXN8N_CONTROL_API_URL,
  workerToken = process.env.WORKER_TOKEN,
  workerId = process.env.WORKER_ID || "integration-delivery-worker",
  fetchImpl = fetch,
  lookup,
} = {}) {
  await workerApiRequest(
    controlApiUrl,
    workerToken,
    "/v1/worker/integrations/maintenance",
    { limit: 100 },
  );

  const delivery = await workerApiRequest(
    controlApiUrl,
    workerToken,
    "/v1/worker/integrations/lease",
    { workerId, leaseSeconds: 90 },
  );
  if (!delivery) return { state: "IDLE" };

  try {
    const result = await deliverIntegrationEvent(delivery, {
      fetchImpl,
      lookup,
    });
    const completed = await workerApiRequest(
      controlApiUrl,
      workerToken,
      `/v1/worker/integrations/${delivery.id}/complete`,
      {
        workerId,
        state: "SENT",
        providerReference: result.providerReference || null,
      },
    );
    return {
      state: completed.state,
      deliveryId: delivery.id,
      provider: delivery.provider,
    };
  } catch (error) {
    const completed = await workerApiRequest(
      controlApiUrl,
      workerToken,
      `/v1/worker/integrations/${delivery.id}/complete`,
      {
        workerId,
        state: "FAILED",
        errorCode: String(error.code || "DELIVERY_FAILED").slice(0, 120),
      },
    );
    return {
      state: completed.state,
      deliveryId: delivery.id,
      provider: delivery.provider,
      errorCode: String(error.code || "DELIVERY_FAILED").slice(0, 120),
    };
  }
}
