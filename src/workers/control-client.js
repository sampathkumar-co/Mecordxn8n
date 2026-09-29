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

export async function workerApiGet(baseUrl, workerToken, path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${workerToken}` },
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`control API returned ${response.status}`);
    error.code = payload?.error || "CONTROL_API_ERROR";
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function getFindingContext({ controlApiUrl, workerToken, findingId }) {
  return workerApiGet(
    controlApiUrl,
    workerToken,
    `/v1/worker/milestone-a/findings/${findingId}`,
  );
}

export function recordVerification({
  controlApiUrl,
  workerToken,
  jobId,
  workerId,
  findingId,
  status,
  attempts,
  matchedAttempts,
  confidence,
  evidence,
  artifacts,
  intelligence,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/milestone-a/jobs/${jobId}/verification`,
    {
      workerId,
      findingId,
      status,
      attempts,
      matchedAttempts,
      confidence,
      evidence,
      artifacts,
      intelligence,
    },
  );
}

export function recordPages({ controlApiUrl, workerToken, jobId, workerId, pages }) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/milestone-a/jobs/${jobId}/pages`,
    { workerId, pages },
  );
}

export function recordJourneyRun({
  controlApiUrl,
  workerToken,
  jobId,
  workerId,
  name,
  state,
  steps,
  evidence,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/milestone-a/jobs/${jobId}/journey-run`,
    { workerId, name, state, steps, evidence },
  );
}

export function recordRemediationResult({
  controlApiUrl,
  workerToken,
  jobId,
  workerId,
  status,
  mcpRequestId,
  mcpResult,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/milestone-a/jobs/${jobId}/remediation-result`,
    { workerId, status, mcpRequestId, mcpResult },
  );
}

export function heartbeatJob({
  controlApiUrl,
  workerToken,
  jobId,
  workerId,
  leaseSeconds = 120,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/jobs/${jobId}/heartbeat`,
    { workerId, leaseSeconds },
  );
}

export function recordMonitoringRun({
  controlApiUrl,
  workerToken,
  jobId,
  workerId,
  policyId,
  snapshot,
  costUnits,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/milestone-b/jobs/${jobId}/monitoring-run`,
    { workerId, policyId, snapshot, costUnits },
  );
}

export function recordMonitoringFailure({
  controlApiUrl,
  workerToken,
  jobId,
  policyId,
  targetId,
  error,
  workerId,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/milestone-b/jobs/${jobId}/monitoring-failure`,
    { policyId, targetId, error, workerId },
  );
}

export function recordRepairOutcome({
  controlApiUrl,
  workerToken,
  jobId,
  remediationRequestId,
  findingId,
  learning,
  workerId,
}) {
  return workerApiRequest(
    controlApiUrl,
    workerToken,
    `/v1/worker/milestone-b/jobs/${jobId}/repair-outcome`,
    { remediationRequestId, findingId, learning, workerId },
  );
}

export function getRepairPatterns({
  controlApiUrl,
  workerToken,
  category,
  limit = 5,
}) {
  return workerApiGet(
    controlApiUrl,
    workerToken,
    `/v1/worker/milestone-b/repair-patterns?category=${encodeURIComponent(category)}&limit=${limit}`,
  );
}
