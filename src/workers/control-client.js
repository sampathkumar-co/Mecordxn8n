export async function workerApiRequest(baseUrl, workerToken, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${workerToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`control API returned ${response.status}`);
    error.code = payload.error || "CONTROL_API_ERROR";
    error.payload = payload;
    throw error;
  }

  return payload;
}

export async function leaseJob({
  controlApiUrl,
  workerToken,
  workerId,
  capabilities,
  leaseSeconds,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    "/v1/worker/jobs/lease",
    { workerId, capabilities, leaseSeconds },
  );
}

export async function recordFinding({
  controlApiUrl,
  workerToken,
  workerId,
  jobId,
  finding,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/jobs/${jobId}/findings`,
    { workerId, finding },
  );
}

export async function completeJob({
  controlApiUrl,
  workerToken,
  workerId,
  jobId,
  state,
  output = null,
  error = null,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/jobs/${jobId}/complete`,
    { workerId, state, output, error },
  );
}
