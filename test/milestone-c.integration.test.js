import test, { after } from "node:test";
import assert from "node:assert/strict";

import { closePool, pool } from "../src/repository.js";
import { createServer } from "../src/server.js";

const enabled = Boolean(process.env.DATABASE_URL);
const TOKEN = "milestone-c-orchestrator";
const WORKER_TOKEN = "milestone-c-worker";

let server;
let baseUrl;

if (enabled) {
  server = createServer({
    orchestratorToken: TOKEN,
    workerToken: WORKER_TOKEN,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

after(async () => {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (enabled) await closePool();
});

async function request(path, { method = "GET", body, token = TOKEN } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: response.status === 204 ? null : await response.json(),
  };
}

async function createVerifiedFixture(host) {
  const target = await request("/v1/targets", {
    method: "POST",
    body: {
      organizationName: `Commercial ${host}`,
      baseUrl: `https://${host}`,
      authorization: {
        mode: "PUBLIC_QA_ONLY",
        allowedHosts: [host],
      },
    },
  });
  assert.equal(target.status, 201);

  const auth = await pool.query(
    `SELECT id FROM authorizations
      WHERE target_id = $1 AND revoked_at IS NULL`,
    [target.body.id],
  );
  const job = await pool.query(
    `INSERT INTO jobs (
       target_id, authorization_id, job_type, capability,
       requested_url, state, input, output, completed_at
     )
     VALUES ($1,$2,'fixture','PUBLIC_HTTP_OBSERVE',$3,'SUCCEEDED','{}','{}',now())
     RETURNING id`,
    [target.body.id, auth.rows[0].id, `https://${host}/checkout`],
  );
  const finding = await pool.query(
    `INSERT INTO findings (
       target_id, first_job_id, last_job_id, fingerprint,
       category, title, severity, confidence, affected_url,
       evidence, status, root_cause_key, verification_state, verified_at
     )
     VALUES (
       $1,$2,$2,$3,'browser-network','Checkout request regression',
       'MEDIUM',0.98,$4,$5::jsonb,'VERIFIED','checkout-api',
       'VERIFIED',now()
     )
     RETURNING *`,
    [
      target.body.id,
      job.rows[0].id,
      `c-${target.body.id}`,
      `https://${host}/checkout`,
      JSON.stringify({ status: 500 }),
    ],
  );
  await pool.query(
    `INSERT INTO finding_verifications (
       finding_id, job_id, status, attempts,
       matched_attempts, confidence, evidence
     )
     VALUES ($1,$2,'VERIFIED',2,2,1,'{"matched":true}'::jsonb)`,
    [finding.rows[0].id, job.rows[0].id],
  );
  await pool.query(
    `INSERT INTO finding_intelligence (
       finding_id, business_impact_score, buyer_relevance,
       repair_feasibility, engineering_effort, opportunity_score,
       impact_tier, affected_journey, rationale, inputs
     )
     VALUES ($1,80,85,90,25,88.50,'HIGH','checkout',
             'Verified checkout regression','{}'::jsonb)`,
    [finding.rows[0].id],
  );

  const report = await request(`/v1/targets/${target.body.id}/reports`, {
    method: "POST",
    body: {},
  });
  assert.equal(report.status, 201);
  const release = await request(
    `/v1/reports/${report.body.id}/request-release`,
    {
      method: "POST",
      body: { requestedBy: "milestone-c-fixture" },
    },
  );
  assert.equal(release.status, 202);
  const approved = await request(
    `/v1/approvals/${release.body.approval.id}/approve`,
    {
      method: "POST",
      body: { decidedBy: "milestone-c-reviewer" },
    },
  );
  assert.equal(approved.status, 200);
  assert.equal(approved.body.report.status, "APPROVED");

  return {
    target: target.body,
    finding: finding.rows[0],
    report: approved.body.report,
  };
}

async function createOpportunity(fixture, extra = {}) {
  const response = await request(
    `/v1/findings/${fixture.finding.id}/commercial-opportunity`,
    {
      method: "POST",
      body: {
        reportId: fixture.report.id,
        estimatedValueMinor: 250000,
        currency: "INR",
        ...extra,
      },
    },
  );
  assert.equal(response.status, 201);
  return response.body;
}

async function createContact(targetId, destination, consentState = "UNKNOWN") {
  const body = {
    displayName: "Commercial contact",
    channel: "EMAIL",
    destination,
    consentState,
  };
  if (["OPTED_IN", "CLIENT_RELATIONSHIP"].includes(consentState)) {
    body.consentSource = "client-confirmed";
    body.consentEvidence = "consent-record-123";
    body.consentExpiresAt = "2099-01-01T00:00:00.000Z";
  }
  const response = await request(
    `/v1/targets/${targetId}/commercial-contacts`,
    { method: "POST", body },
  );
  assert.equal(response.status, 201);
  return response.body;
}

async function createAction(opportunityId, contactId, reportId, kind = "INITIAL_REACHOUT") {
  const response = await request(
    `/v1/commercial-opportunities/${opportunityId}/outbound-actions`,
    {
      method: "POST",
      body: {
        contactId,
        reportId,
        kind,
        subject: "Verified issue evidence",
        body: "A verified quality issue was observed. This draft is not sent automatically.",
      },
    },
  );
  assert.equal(response.status, 201);
  return response.body;
}

test(
  "Milestone C only promotes the latest verified state and cannot fabricate a win",
  { skip: !enabled },
  async () => {
    const fixture = await createVerifiedFixture("commercial-verified.example.com");
    const first = await createOpportunity(fixture);
    const duplicate = await createOpportunity(fixture);
    assert.equal(duplicate.id, first.id);
    assert.equal(first.state, "NEW");
    assert.equal(first.opportunityScore, 88.5);

    const qualified = await request(
      `/v1/commercial-opportunities/${first.id}/transition`,
      { method: "POST", body: { state: "QUALIFIED" } },
    );
    assert.equal(qualified.status, 200);
    assert.equal(qualified.body.state, "QUALIFIED");

    const fakeWin = await request(
      `/v1/commercial-opportunities/${first.id}/transition`,
      { method: "POST", body: { state: "WON" } },
    );
    assert.equal(fakeWin.status, 409);
    assert.equal(fakeWin.body.error, "INVALID_OPPORTUNITY_TRANSITION");

    const auth = await pool.query(
      "SELECT authorization_id FROM jobs WHERE id = $1",
      [fixture.finding.last_job_id],
    );
    const job = await pool.query(
      `INSERT INTO jobs (
         target_id, authorization_id, job_type, capability,
         requested_url, state, input, output, completed_at
       )
       VALUES ($1,$2,'fixture-reverify','FINDING_VERIFY',$3,
               'SUCCEEDED','{}','{}',now())
       RETURNING id`,
      [
        fixture.target.id,
        auth.rows[0].authorization_id,
        fixture.finding.affected_url,
      ],
    );
    await pool.query(
      `INSERT INTO finding_verifications (
         finding_id, job_id, status, attempts,
         matched_attempts, confidence, evidence
       )
       VALUES ($1,$2,'NOT_REPRODUCED',2,0,0.1,'{}'::jsonb)`,
      [fixture.finding.id, job.rows[0].id],
    );

    const stale = await request(
      `/v1/findings/${fixture.finding.id}/commercial-opportunity`,
      { method: "POST", body: { reportId: fixture.report.id } },
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "FINDING_NOT_VERIFIED");
  },
);

test(
  "consent, report release, approval, delivery and opt-out fail closed",
  { skip: !enabled },
  async () => {
    const fixture = await createVerifiedFixture("commercial-consent.example.com");
    const opportunity = await createOpportunity(fixture);
    const unknown = await createContact(
      fixture.target.id,
      "buyer@example.com",
      "UNKNOWN",
    );
    const action = await createAction(
      opportunity.id,
      unknown.id,
      fixture.report.id,
    );

    const blockedApproval = await request(
      `/v1/outbound-actions/${action.id}/request-approval`,
      { method: "POST", body: { requestedBy: "owner" } },
    );
    assert.equal(blockedApproval.status, 409);
    assert.equal(blockedApproval.body.error, "CONSENT_REQUIRED");

    const consent = await request(
      `/v1/commercial-contacts/${unknown.id}/consent`,
      {
        method: "POST",
        body: {
          consentState: "OPTED_IN",
          consentSource: "customer-form",
          consentEvidence: "form-consent-456",
          consentExpiresAt: "2099-01-01T00:00:00.000Z",
        },
      },
    );
    assert.equal(consent.status, 200);

    const approvalRequest = await request(
      `/v1/outbound-actions/${action.id}/request-approval`,
      { method: "POST", body: { requestedBy: "owner" } },
    );
    assert.equal(approvalRequest.status, 202);
    assert.equal(approvalRequest.body.action.state, "PENDING_APPROVAL");

    const approved = await request(
      `/v1/approvals/${approvalRequest.body.approval.id}/approve`,
      {
        method: "POST",
        body: { decidedBy: "owner" },
      },
    );
    assert.equal(approved.status, 201);
    assert.equal(approved.body.action.state, "APPROVED");

    const replay = await request(
      `/v1/approvals/${approvalRequest.body.approval.id}/approve`,
      {
        method: "POST",
        body: { decidedBy: "owner" },
      },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotentReplay, true);

    const opposite = await request(
      `/v1/approvals/${approvalRequest.body.approval.id}/reject`,
      {
        method: "POST",
        body: { decidedBy: "owner" },
      },
    );
    assert.equal(opposite.status, 409);

    const sent = await request(
      `/v1/outbound-actions/${action.id}/record-delivery`,
      {
        method: "POST",
        body: {
          state: "SENT",
          deliveredBy: "owner-manual",
          providerReference: "manual-message-1",
        },
      },
    );
    assert.equal(sent.status, 200);
    assert.equal(sent.body.state, "SENT");

    const response = await request(
      `/v1/outbound-actions/${action.id}/responses`,
      {
        method: "POST",
        body: {
          responseType: "INTERESTED",
          summary: "Recipient asked to discuss the verified issue.",
        },
      },
    );
    assert.equal(response.status, 201);

    const engaged = await request(
      `/v1/commercial-opportunities/${opportunity.id}`,
    );
    assert.equal(engaged.body.state, "ENGAGED");

    await pool.query(
      `UPDATE commercial_actions
          SET approved_at = now() - interval '2 hours'
        WHERE id = $1`,
      [action.id],
    );
    await request(
      `/v1/targets/${fixture.target.id}/commercial-policy`,
      {
        method: "POST",
        body: { dailyActivationLimit: 10, cooldownHours: 1 },
      },
    );
    const followup = await createAction(
      opportunity.id,
      unknown.id,
      fixture.report.id,
      "FOLLOW_UP",
    );
    const followupApproval = await request(
      `/v1/outbound-actions/${followup.id}/request-approval`,
      { method: "POST", body: { requestedBy: "owner" } },
    );
    assert.equal(followupApproval.status, 202);
    const followupApproved = await request(
      `/v1/approvals/${followupApproval.body.approval.id}/approve`,
      { method: "POST", body: { decidedBy: "owner" } },
    );
    assert.equal(followupApproved.status, 201);

    const optOut = await request(
      `/v1/commercial-contacts/${unknown.id}/consent`,
      {
        method: "POST",
        body: {
          consentState: "OPTED_OUT",
          consentSource: "recipient-response",
          consentEvidence: "explicit-stop",
          suppressionReason: "recipient requested no further contact",
        },
      },
    );
    assert.equal(optOut.status, 200);
    assert.equal(optOut.body.consentState, "OPTED_OUT");

    const blocked = await request(`/v1/outbound-actions/${followup.id}`);
    assert.equal(blocked.body.state, "BLOCKED");

    const sendAfterOptOut = await request(
      `/v1/outbound-actions/${followup.id}/record-delivery`,
      {
        method: "POST",
        body: { state: "SENT", deliveredBy: "owner-manual" },
      },
    );
    assert.equal(sendAfterOptOut.status, 409);

    const audit = await pool.query(
      `SELECT payload FROM audit_events
        WHERE target_id = $1
          AND event_type LIKE 'COMMERCIAL_%'
           OR target_id = $1
          AND event_type LIKE 'OUTBOUND_%'`,
      [fixture.target.id],
    );
    assert.equal(
      JSON.stringify(audit.rows).includes("buyer@example.com"),
      false,
    );
  },
);

test(
  "concurrent outbound approvals obey the daily activation limit",
  { skip: !enabled },
  async () => {
    const fixture = await createVerifiedFixture("commercial-cap.example.com");
    const opportunity = await createOpportunity(fixture);
    await request(
      `/v1/targets/${fixture.target.id}/commercial-policy`,
      {
        method: "POST",
        body: { dailyActivationLimit: 1, cooldownHours: 1 },
      },
    );

    const firstContact = await createContact(
      fixture.target.id,
      "one@example.com",
      "OPTED_IN",
    );
    const secondContact = await createContact(
      fixture.target.id,
      "two@example.com",
      "OPTED_IN",
    );
    const firstAction = await createAction(
      opportunity.id,
      firstContact.id,
      fixture.report.id,
    );
    const secondAction = await createAction(
      opportunity.id,
      secondContact.id,
      fixture.report.id,
    );

    const firstApproval = await request(
      `/v1/outbound-actions/${firstAction.id}/request-approval`,
      { method: "POST", body: { requestedBy: "owner" } },
    );
    const secondApproval = await request(
      `/v1/outbound-actions/${secondAction.id}/request-approval`,
      { method: "POST", body: { requestedBy: "owner" } },
    );
    assert.equal(firstApproval.status, 202);
    assert.equal(secondApproval.status, 202);

    const decisions = await Promise.all([
      request(
        `/v1/approvals/${firstApproval.body.approval.id}/approve`,
        { method: "POST", body: { decidedBy: "owner-a" } },
      ),
      request(
        `/v1/approvals/${secondApproval.body.approval.id}/approve`,
        { method: "POST", body: { decidedBy: "owner-b" } },
      ),
    ]);
    assert.deepEqual(
      decisions.map((item) => item.status).sort(),
      [201, 409],
    );
    assert.ok(
      decisions.some(
        (item) => item.body.error === "DAILY_ACTIVATION_LIMIT",
      ),
    );

    const actions = await pool.query(
      `SELECT state, COUNT(*)::int AS count
         FROM commercial_actions
        WHERE id = ANY($1::uuid[])
        GROUP BY state`,
      [[firstAction.id, secondAction.id]],
    );
    const states = Object.fromEntries(
      actions.rows.map((row) => [row.state, row.count]),
    );
    assert.equal(states.APPROVED, 1);
    assert.equal(states.BLOCKED, 1);
  },
);

test(
  "revenue attribution is idempotent and services require received cash",
  { skip: !enabled },
  async () => {
    const fixture = await createVerifiedFixture("commercial-revenue.example.com");
    const opportunity = await createOpportunity(fixture);

    const premature = await request(
      `/v1/commercial-opportunities/${opportunity.id}/services`,
      {
        method: "POST",
        body: {
          name: "Continuous reliability",
          amountMinor: 50000,
          currency: "INR",
          cadenceDays: 30,
        },
      },
    );
    assert.equal(premature.status, 409);
    assert.equal(premature.body.error, "REVENUE_REQUIRED");

    const contracted = await request(
      `/v1/commercial-opportunities/${opportunity.id}/revenue`,
      {
        method: "POST",
        body: {
          kind: "CONTRACTED",
          amountMinor: 100000,
          currency: "INR",
          externalReference: "contract-1",
        },
      },
    );
    assert.equal(contracted.status, 201);

    const stillOpen = await request(
      `/v1/commercial-opportunities/${opportunity.id}`,
    );
    assert.notEqual(stillOpen.body.state, "WON");

    const received = await request(
      `/v1/commercial-opportunities/${opportunity.id}/revenue`,
      {
        method: "POST",
        body: {
          kind: "RECEIVED",
          amountMinor: 80000,
          currency: "INR",
          externalReference: "payment-1",
        },
      },
    );
    assert.equal(received.status, 201);

    const replay = await request(
      `/v1/commercial-opportunities/${opportunity.id}/revenue`,
      {
        method: "POST",
        body: {
          kind: "RECEIVED",
          amountMinor: 80000,
          currency: "INR",
          externalReference: "payment-1",
        },
      },
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.idempotent, true);

    const won = await request(
      `/v1/commercial-opportunities/${opportunity.id}`,
    );
    assert.equal(won.body.state, "WON");

    const refund = await request(
      `/v1/commercial-opportunities/${opportunity.id}/revenue`,
      {
        method: "POST",
        body: {
          kind: "REFUNDED",
          amountMinor: 10000,
          currency: "INR",
          externalReference: "refund-1",
        },
      },
    );
    assert.equal(refund.status, 201);

    const renewal = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const service = await request(
      `/v1/commercial-opportunities/${opportunity.id}/services`,
      {
        method: "POST",
        body: {
          name: "Continuous reliability",
          amountMinor: 50000,
          currency: "INR",
          cadenceDays: 30,
          renewalAt: renewal,
        },
      },
    );
    assert.equal(service.status, 201);
    assert.equal(service.body.status, "ACTIVE");

    const metrics = await request("/v1/revenue/metrics");
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.pipeline.WON >= 1);
    assert.ok(metrics.body.revenueByCurrency.INR.receivedMinor >= 80000);
    assert.ok(metrics.body.revenueByCurrency.INR.refundedMinor >= 10000);
    assert.ok(metrics.body.revenueByCurrency.INR.netReceivedMinor >= 70000);
    assert.ok(metrics.body.services.active >= 1);
    assert.ok(metrics.body.services.renewalsDue7d >= 1);

    const maintenance = await request("/v1/commercial/maintenance", {
      method: "POST",
      body: { limit: 100 },
    });
    assert.equal(maintenance.status, 200);
    assert.ok(
      maintenance.body.dueRenewals.some(
        (item) => item.id === service.body.id,
      ),
    );
  },
);
