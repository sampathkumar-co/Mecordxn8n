import { deliverIntegrationEvent } from "../integrations/delivery.js";
import {
  completeIntegrationDelivery,
  leaseIntegrationDelivery,
} from "../integrations/repository.js";

const workerId =
  process.env.WORKER_ID ||
  ("integration-dispatcher-" + process.pid);
const pollMs = Math.min(
  Math.max(Number(process.env.INTEGRATION_POLL_MS) || 5000, 1000),
  60000,
);
const leaseSeconds = Math.min(
  Math.max(Number(process.env.INTEGRATION_LEASE_SECONDS) || 60, 15),
  300,
);

let stopping = false;

async function runOne() {
  const delivery = await leaseIntegrationDelivery({
    workerId,
    leaseSeconds,
  });
  if (!delivery) return false;

  try {
    const result = await deliverIntegrationEvent(delivery);
    const completed = await completeIntegrationDelivery({
      deliveryId: delivery.id,
      workerId,
      state: "SENT",
      providerReference: result?.providerReference || null,
    });
    if (!completed) {
      console.error(
        JSON.stringify({
          event: "integration_delivery_lost_lease",
          deliveryId: delivery.id,
        }),
      );
    }
  } catch (error) {
    const code = String(error?.code || "INTEGRATION_DELIVERY_FAILED")
      .replace(/[^A-Z0-9_.-]/gi, "_")
      .slice(0, 120);
    const completed = await completeIntegrationDelivery({
      deliveryId: delivery.id,
      workerId,
      state: "FAILED",
      errorCode: code,
    });
    if (!completed) {
      console.error(
        JSON.stringify({
          event: "integration_delivery_failure_lost_lease",
          deliveryId: delivery.id,
          code,
        }),
      );
    }
  }

  return true;
}

async function drain(maxItems = 25) {
  let processed = 0;
  while (!stopping && processed < maxItems) {
    const hadWork = await runOne();
    if (!hadWork) break;
    processed += 1;
  }
  return processed;
}

async function loop() {
  while (!stopping) {
    try {
      const processed = await drain();
      if (processed === 0) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "integration_dispatcher_loop_error",
          code: String(error?.code || "UNKNOWN").slice(0, 120),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
  });
}

loop().catch((error) => {
  console.error(
    JSON.stringify({
      event: "integration_dispatcher_fatal",
      code: String(error?.code || "UNKNOWN").slice(0, 120),
    }),
  );
  process.exitCode = 1;
});
