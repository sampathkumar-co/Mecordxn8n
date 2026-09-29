import {
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalRequest,
} from "../milestone-b/repository.js";
import {
  getFindingContext,
  getReport,
  getTarget,
} from "../milestone-a/repository.js";
import {
  activateCommercialAction,
  checkCommercialActionEligibility,
  createCommercialAction,
  createCommercialContact,
  createCommercialOpportunity,
  createServiceAgreement,
  getCommercialAction,
  getCommercialContact,
  getCommercialMaintenance,
  getCommercialOpportunity,
  getCommercialPolicy,
  getRevenueMetrics,
  listCommercialActions,
  listCommercialContacts,
  listCommercialOpportunities,
  markCommercialActionPending,
  recordCommercialDelivery,
  recordCommercialResponse,
  recordRevenueEvent,
  reconcileExpiredCommercialApprovals,
  rejectCommercialAction,
  transitionCommercialOpportunity,
  updateServiceAgreement,
  updateCommercialConsent,
  updateCommercialPolicy,
} from "./repository.js";
import {
  normalizeActionKind,
  normalizeCommercialChannel,
  normalizeConsentState,
  normalizeCurrency,
  normalizeResponseType,
  normalizeRevenueKind,
} from "./policy.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPPORTUNITY_STATES = new Set([
  "NEW",
  "QUALIFIED",
  "ENGAGED",
  "PROPOSAL",
  "NEGOTIATING",
  "WON",
  "LOST",
  "PAUSED",
]);

function validId(value) {
  return UUID_RE.test(String(value || ""));
}

function boundedString(value, max, name, badRequest, { required = false } = {}) {
  const result = String(value || "").trim();
  if (required && !result) throw badRequest(`${name} is required`);
  if (result.length > max) throw badRequest(`${name} is too long`);
  return result || null;
}

function parseDate(value, name, badRequest, { future = false } = {}) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest(`${name} is invalid`);
  if (future && date.getTime() <= Date.now()) {
    throw badRequest(`${name} must be in the future`);
  }
  return date.toISOString();
}

function parseMinor(value, name, badRequest, { allowZero = false } = {}) {
  if (value == null) return null;
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    (allowZero ? number < 0 : number <= 0)
  ) {
    throw badRequest(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} safe integer`,
    );
  }
  return number;
}

function boundedObject(value, name, badRequest, maxBytes = 32 * 1024) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw badRequest(`${name} must be a JSON object`);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) {
    throw badRequest(`${name} is too large`);
  }
  return value;
}

function approvalFailure(json, res, result) {
  if (result.status === "NOT_FOUND") {
    json(res, 404, { error: "APPROVAL_NOT_FOUND" });
    return true;
  }
  if (result.status === "EXPIRED") {
    json(res, 409, {
      error: "APPROVAL_EXPIRED",
      approval: result.approval,
    });
    return true;
  }
  return false;
}

export async function handleMilestoneCRoute({
  req,
  res,
  url,
  json,
  readJson,
  badRequest,
}) {
  let match;

  match = url.pathname.match(
    /^\/v1\/approvals\/([0-9a-f-]+)\/(approve|reject)$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("approval id is invalid");
    const current = await getApprovalRequest(match[1]);
    if (!current || current.actionType !== "OUTBOUND_CONTACT") return false;

    const body = await readJson(req);
    const decidedBy = boundedString(
      body.decidedBy,
      160,
      "decidedBy",
      badRequest,
      { required: true },
    );
    const decision = match[2] === "approve" ? "APPROVED" : "REJECTED";
    const result = await decideApprovalRequest({
      approvalId: current.id,
      decision,
      decidedBy,
      decisionNote: boundedString(
        body.decisionNote,
        2000,
        "decisionNote",
        badRequest,
      ),
    });

    if (result.status === "EXPIRED") {
      await reconcileExpiredCommercialApprovals(10);
    }
    const failure = approvalFailure(json, res, result);
    if (failure) return failure;

    if (result.status === "ALREADY_DECIDED") {
      if (result.approval.status === "EXPIRED") {
        await reconcileExpiredCommercialApprovals(10);
        return json(res, 409, {
          error: "APPROVAL_EXPIRED",
          approval: result.approval,
        });
      }
      if (
        decision === "APPROVED" &&
        result.approval.status === "APPROVED"
      ) {
        const activation = await activateCommercialAction({
          actionId: result.approval.commercialActionId,
          approvalId: result.approval.id,
        });
        if (!activation.ok) {
          return json(res, activation.statusCode || 409, {
            error: activation.code,
            approval: result.approval,
          });
        }
        return json(res, 200, {
          approval: result.approval,
          action: activation.action,
          idempotentReplay: true,
        });
      }
      if (
        decision === "REJECTED" &&
        result.approval.status === "REJECTED"
      ) {
        return json(res, 200, {
          approval: result.approval,
          action: await rejectCommercialAction({
            actionId: result.approval.commercialActionId,
            approvalId: result.approval.id,
          }),
          idempotentReplay: true,
        });
      }
      return json(res, 409, {
        error: "APPROVAL_ALREADY_DECIDED",
        approval: result.approval,
      });
    }

    if (decision === "REJECTED") {
      return json(res, 200, {
        approval: result.approval,
        action: await rejectCommercialAction({
          actionId: result.approval.commercialActionId,
          approvalId: result.approval.id,
        }),
      });
    }

    const activation = await activateCommercialAction({
      actionId: result.approval.commercialActionId,
      approvalId: result.approval.id,
    });
    if (!activation.ok) {
      return json(res, activation.statusCode || 409, {
        error: activation.code,
        approval: result.approval,
      });
    }
    return json(res, 201, {
      approval: result.approval,
      action: activation.action,
    });
  }

  match = url.pathname.match(
    /^\/v1\/findings\/([0-9a-f-]+)\/commercial-opportunity$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("finding id is invalid");
    const finding = await getFindingContext(match[1]);
    if (!finding) return json(res, 404, { error: "FINDING_NOT_FOUND" });
    if (finding.verification?.status !== "VERIFIED") {
      return json(res, 409, { error: "FINDING_NOT_VERIFIED" });
    }

    const body = await readJson(req);
    let report = null;
    if (body.reportId != null) {
      if (!validId(body.reportId)) throw badRequest("reportId is invalid");
      report = await getReport(body.reportId);
      if (!report) return json(res, 404, { error: "REPORT_NOT_FOUND" });
      if (report.target_id !== finding.targetId) {
        return json(res, 409, { error: "COMMERCIAL_CONTEXT_MISMATCH" });
      }
    }

    const estimatedValueMinor = parseMinor(
      body.estimatedValueMinor,
      "estimatedValueMinor",
      badRequest,
      { allowZero: true },
    );
    const currency =
      body.currency == null ? null : normalizeCurrency(body.currency);
    if (body.currency != null && !currency) {
      throw badRequest("currency must be a 3-letter code");
    }
    if (estimatedValueMinor != null && !currency) {
      throw badRequest("currency is required when estimatedValueMinor is set");
    }

    const opportunity = await createCommercialOpportunity({
      finding,
      sourceReportId: report?.id || null,
      title: boundedString(body.title, 240, "title", badRequest),
      estimatedValueMinor,
      currency,
      nextActionAt: parseDate(
        body.nextActionAt,
        "nextActionAt",
        badRequest,
      ),
      metadata: boundedObject(body.metadata, "metadata", badRequest),
    });
    return json(res, 201, opportunity);
  }

  match = url.pathname.match(
    /^\/v1\/targets\/([0-9a-f-]+)\/commercial-opportunities$/i,
  );
  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    const state = url.searchParams.get("state");
    if (state && !OPPORTUNITY_STATES.has(state)) {
      throw badRequest("opportunity state is invalid");
    }
    return json(res, 200, {
      opportunities: await listCommercialOpportunities({
        targetId: match[1],
        state,
        limit: url.searchParams.get("limit") || 100,
      }),
    });
  }

  match = url.pathname.match(
    /^\/v1\/commercial-opportunities\/([0-9a-f-]+)$/i,
  );
  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("opportunity id is invalid");
    const opportunity = await getCommercialOpportunity(match[1]);
    if (!opportunity) {
      return json(res, 404, { error: "COMMERCIAL_OPPORTUNITY_NOT_FOUND" });
    }
    return json(res, 200, opportunity);
  }

  match = url.pathname.match(
    /^\/v1\/commercial-opportunities\/([0-9a-f-]+)\/transition$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("opportunity id is invalid");
    const body = await readJson(req);
    const nextState = String(body.state || "").toUpperCase();
    if (!OPPORTUNITY_STATES.has(nextState)) {
      throw badRequest("opportunity state is invalid");
    }

    const estimatedValueMinor =
      body.estimatedValueMinor === undefined
        ? undefined
        : parseMinor(
            body.estimatedValueMinor,
            "estimatedValueMinor",
            badRequest,
            { allowZero: true },
          );
    const currency =
      body.currency === undefined
        ? undefined
        : normalizeCurrency(body.currency);
    if (body.currency !== undefined && !currency) {
      throw badRequest("currency must be a 3-letter code");
    }

    const opportunity = await transitionCommercialOpportunity({
      opportunityId: match[1],
      nextState,
      nextActionAt:
        body.nextActionAt === undefined
          ? undefined
          : parseDate(body.nextActionAt, "nextActionAt", badRequest),
      estimatedValueMinor,
      currency,
      metadata:
        body.metadata === undefined
          ? undefined
          : boundedObject(body.metadata, "metadata", badRequest),
    });
    if (!opportunity) {
      return json(res, 404, { error: "COMMERCIAL_OPPORTUNITY_NOT_FOUND" });
    }
    return json(res, 200, opportunity);
  }

  match = url.pathname.match(
    /^\/v1\/targets\/([0-9a-f-]+)\/commercial-contacts$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    const target = await getTarget(match[1]);
    if (!target) return json(res, 404, { error: "TARGET_NOT_FOUND" });

    const body = await readJson(req);
    const channel = normalizeCommercialChannel(body.channel);
    if (!channel) throw badRequest("commercial contact channel is invalid");
    const destination = boundedString(
      body.destination,
      320,
      "destination",
      badRequest,
      { required: true },
    );
    if (
      channel === "EMAIL" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)
    ) {
      throw badRequest("email destination is invalid");
    }
    if (
      ["PHONE", "WHATSAPP"].includes(channel) &&
      !/^\+?[0-9][0-9 .()-]{5,30}$/.test(destination)
    ) {
      throw badRequest("phone destination is invalid");
    }
    const consentState =
      body.consentState == null
        ? "UNKNOWN"
        : normalizeConsentState(body.consentState);
    if (!consentState) throw badRequest("consentState is invalid");

    const consentSource = boundedString(
      body.consentSource,
      240,
      "consentSource",
      badRequest,
    );
    const consentEvidence = boundedString(
      body.consentEvidence,
      1000,
      "consentEvidence",
      badRequest,
    );
    if (
      ["OPTED_IN", "CLIENT_RELATIONSHIP"].includes(consentState) &&
      (!consentSource || !consentEvidence)
    ) {
      throw badRequest(
        "allowed contact consent requires consentSource and consentEvidence",
      );
    }

    const contact = await createCommercialContact({
      targetId: target.id,
      displayName: boundedString(
        body.displayName,
        240,
        "displayName",
        badRequest,
      ),
      channel,
      destination,
      consentState,
      consentSource,
      consentEvidence,
      consentExpiresAt: parseDate(
        body.consentExpiresAt,
        "consentExpiresAt",
        badRequest,
        {
          future: ["OPTED_IN", "CLIENT_RELATIONSHIP"].includes(consentState),
        },
      ),
    });
    return json(res, 201, contact);
  }

  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    return json(res, 200, {
      contacts: await listCommercialContacts(
        match[1],
        url.searchParams.get("limit") || 100,
      ),
    });
  }

  match = url.pathname.match(
    /^\/v1\/commercial-contacts\/([0-9a-f-]+)\/consent$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("contact id is invalid");
    const body = await readJson(req);
    const consentState = normalizeConsentState(body.consentState);
    if (!consentState) throw badRequest("consentState is invalid");
    const consentSource = boundedString(
      body.consentSource,
      240,
      "consentSource",
      badRequest,
    );
    const consentEvidence = boundedString(
      body.consentEvidence,
      1000,
      "consentEvidence",
      badRequest,
    );
    if (
      ["OPTED_IN", "CLIENT_RELATIONSHIP"].includes(consentState) &&
      (!consentSource || !consentEvidence)
    ) {
      throw badRequest(
        "allowed contact consent requires consentSource and consentEvidence",
      );
    }
    const contact = await updateCommercialConsent({
      contactId: match[1],
      consentState,
      consentSource,
      consentEvidence,
      consentExpiresAt: parseDate(
        body.consentExpiresAt,
        "consentExpiresAt",
        badRequest,
        {
          future: ["OPTED_IN", "CLIENT_RELATIONSHIP"].includes(consentState),
        },
      ),
      suppressionReason: boundedString(
        body.suppressionReason,
        1000,
        "suppressionReason",
        badRequest,
      ),
    });
    if (!contact) return json(res, 404, { error: "COMMERCIAL_CONTACT_NOT_FOUND" });
    return json(res, 200, contact);
  }

  match = url.pathname.match(
    /^\/v1\/targets\/([0-9a-f-]+)\/commercial-policy$/i,
  );
  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    const target = await getTarget(match[1]);
    if (!target) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    return json(res, 200, await getCommercialPolicy(match[1]));
  }
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    const target = await getTarget(match[1]);
    if (!target) return json(res, 404, { error: "TARGET_NOT_FOUND" });
    const body = await readJson(req);
    const dailyActivationLimit = Number(body.dailyActivationLimit ?? 3);
    const cooldownHours = Number(body.cooldownHours ?? 72);
    if (
      !Number.isInteger(dailyActivationLimit) ||
      dailyActivationLimit < 1 ||
      dailyActivationLimit > 50
    ) {
      throw badRequest("dailyActivationLimit must be an integer from 1 to 50");
    }
    if (
      !Number.isInteger(cooldownHours) ||
      cooldownHours < 1 ||
      cooldownHours > 720
    ) {
      throw badRequest("cooldownHours must be an integer from 1 to 720");
    }
    return json(
      res,
      200,
      await updateCommercialPolicy({
        targetId: target.id,
        dailyActivationLimit,
        cooldownHours,
      }),
    );
  }

  match = url.pathname.match(
    /^\/v1\/commercial-opportunities\/([0-9a-f-]+)\/outbound-actions$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("opportunity id is invalid");
    const body = await readJson(req);
    if (!validId(body.contactId)) throw badRequest("contactId is invalid");
    if (!validId(body.reportId)) throw badRequest("reportId is invalid");
    const kind = normalizeActionKind(body.kind);
    if (!kind) throw badRequest("commercial action kind is invalid");
    const messageBody = boundedString(
      body.body,
      20_000,
      "body",
      badRequest,
      { required: true },
    );

    try {
      const action = await createCommercialAction({
        opportunityId: match[1],
        contactId: body.contactId,
        reportId: body.reportId,
        kind,
        subject: boundedString(body.subject, 240, "subject", badRequest),
        body: messageBody,
      });
      return json(res, 201, action);
    } catch (error) {
      if (error.code === "23505") {
        return json(res, 409, { error: "COMMERCIAL_ACTION_ALREADY_ACTIVE" });
      }
      throw error;
    }
  }

  match = url.pathname.match(
    /^\/v1\/targets\/([0-9a-f-]+)\/outbound-actions$/i,
  );
  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("target id is invalid");
    return json(res, 200, {
      actions: await listCommercialActions({
        targetId: match[1],
        state: url.searchParams.get("state"),
        limit: url.searchParams.get("limit") || 100,
      }),
    });
  }

  match = url.pathname.match(/^\/v1\/outbound-actions\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && match) {
    if (!validId(match[1])) throw badRequest("action id is invalid");
    const action = await getCommercialAction(match[1]);
    if (!action) return json(res, 404, { error: "COMMERCIAL_ACTION_NOT_FOUND" });
    return json(res, 200, action);
  }

  match = url.pathname.match(
    /^\/v1\/outbound-actions\/([0-9a-f-]+)\/request-approval$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("action id is invalid");
    const action = await getCommercialAction(match[1]);
    if (!action) return json(res, 404, { error: "COMMERCIAL_ACTION_NOT_FOUND" });
    if (action.state !== "DRAFT") {
      return json(res, 409, { error: "COMMERCIAL_ACTION_NOT_DRAFT" });
    }
    const eligibility = await checkCommercialActionEligibility(action.id);
    if (!eligibility.ok) {
      return json(res, eligibility.statusCode || 409, {
        error: eligibility.code,
      });
    }

    const body = await readJson(req);
    try {
      const approval = await createApprovalRequest({
        targetId: action.targetId,
        commercialActionId: action.id,
        actionType: "OUTBOUND_CONTACT",
        payload: {
          actionId: action.id,
          opportunityId: action.opportunityId,
          contactId: action.contactId,
          reportId: action.reportId,
        },
        requestedBy:
          boundedString(
            body.requestedBy,
            160,
            "requestedBy",
            badRequest,
          ) || "chat",
        expiresMinutes: body.expiresMinutes || 120,
      });
      const pending = await markCommercialActionPending({
        actionId: action.id,
        approvalId: approval.id,
      });
      return json(res, 202, {
        approvalRequired: true,
        approval,
        action: pending || action,
      });
    } catch (error) {
      if (error.code === "23505") {
        return json(res, 409, { error: "APPROVAL_ALREADY_PENDING" });
      }
      throw error;
    }
  }

  match = url.pathname.match(
    /^\/v1\/outbound-actions\/([0-9a-f-]+)\/record-delivery$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("action id is invalid");
    const body = await readJson(req);
    const state = String(body.state || "").toUpperCase();
    if (!["SENT", "FAILED"].includes(state)) {
      throw badRequest("delivery state must be SENT or FAILED");
    }
    const deliveredBy = boundedString(
      body.deliveredBy,
      160,
      "deliveredBy",
      badRequest,
      { required: true },
    );
    const result = await recordCommercialDelivery({
      actionId: match[1],
      state,
      deliveredBy,
      providerReference: boundedString(
        body.providerReference,
        500,
        "providerReference",
        badRequest,
      ),
      failureCode: boundedString(
        body.failureCode,
        120,
        "failureCode",
        badRequest,
      ),
    });
    if (!result) return json(res, 404, { error: "COMMERCIAL_ACTION_NOT_FOUND" });
    if (result.blocked) {
      return json(res, 409, { error: result.code });
    }
    return json(res, 200, result);
  }

  match = url.pathname.match(
    /^\/v1\/outbound-actions\/([0-9a-f-]+)\/responses$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("action id is invalid");
    const body = await readJson(req);
    const responseType = normalizeResponseType(body.responseType);
    if (!responseType) throw badRequest("responseType is invalid");
    const result = await recordCommercialResponse({
      actionId: match[1],
      responseType,
      summary: boundedString(body.summary, 2000, "summary", badRequest),
      occurredAt: parseDate(body.occurredAt, "occurredAt", badRequest),
    });
    if (!result) return json(res, 404, { error: "COMMERCIAL_ACTION_NOT_FOUND" });
    return json(res, 201, result);
  }

  match = url.pathname.match(
    /^\/v1\/commercial-opportunities\/([0-9a-f-]+)\/revenue$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("opportunity id is invalid");
    const body = await readJson(req);
    const kind = normalizeRevenueKind(body.kind);
    if (!kind) throw badRequest("revenue kind is invalid");
    const currency = normalizeCurrency(body.currency);
    if (!currency) throw badRequest("currency must be a 3-letter code");
    const externalReference = boundedString(
      body.externalReference,
      240,
      "externalReference",
      badRequest,
    );
    if (["RECEIVED", "REFUNDED"].includes(kind) && !externalReference) {
      throw badRequest(
        "externalReference is required for received or refunded revenue",
      );
    }
    const result = await recordRevenueEvent({
      opportunityId: match[1],
      kind,
      amountMinor: parseMinor(body.amountMinor, "amountMinor", badRequest),
      currency,
      externalReference,
      occurredAt: parseDate(body.occurredAt, "occurredAt", badRequest),
    });
    if (!result) {
      return json(res, 404, { error: "COMMERCIAL_OPPORTUNITY_NOT_FOUND" });
    }
    return json(res, result.idempotent ? 200 : 201, result);
  }

  match = url.pathname.match(
    /^\/v1\/commercial-opportunities\/([0-9a-f-]+)\/services$/i,
  );
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("opportunity id is invalid");
    const body = await readJson(req);
    const amountMinor =
      body.amountMinor == null
        ? null
        : parseMinor(body.amountMinor, "amountMinor", badRequest, {
            allowZero: true,
          });
    const currency =
      body.currency == null ? null : normalizeCurrency(body.currency);
    if (body.currency != null && !currency) {
      throw badRequest("currency must be a 3-letter code");
    }
    if (amountMinor != null && !currency) {
      throw badRequest("currency is required when amountMinor is set");
    }
    const cadenceDays =
      body.cadenceDays == null ? null : Number(body.cadenceDays);
    if (
      cadenceDays != null &&
      (!Number.isInteger(cadenceDays) ||
        cadenceDays < 1 ||
        cadenceDays > 3650)
    ) {
      throw badRequest("cadenceDays must be an integer from 1 to 3650");
    }

    const service = await createServiceAgreement({
      opportunityId: match[1],
      name: boundedString(body.name, 240, "name", badRequest, {
        required: true,
      }),
      amountMinor,
      currency,
      renewalAt: parseDate(body.renewalAt, "renewalAt", badRequest),
      cadenceDays,
    });
    if (!service) {
      return json(res, 404, { error: "COMMERCIAL_OPPORTUNITY_NOT_FOUND" });
    }
    return json(res, 201, service);
  }

  match = url.pathname.match(/^\/v1\/services\/([0-9a-f-]+)\/transition$/i);
  if (req.method === "POST" && match) {
    if (!validId(match[1])) throw badRequest("service id is invalid");
    const body = await readJson(req);
    const status = String(body.status || "").trim().toUpperCase();
    if (!["ACTIVE", "PAUSED", "CANCELLED", "ENDED"].includes(status)) {
      throw badRequest("service status is invalid");
    }
    const service = await updateServiceAgreement({
      serviceId: match[1],
      status,
      renewalAt:
        body.renewalAt === undefined
          ? undefined
          : parseDate(body.renewalAt, "renewalAt", badRequest),
    });
    if (!service) {
      return json(res, 404, { error: "SERVICE_AGREEMENT_NOT_FOUND" });
    }
    return json(res, 200, service);
  }

  if (req.method === "GET" && url.pathname === "/v1/revenue/metrics") {
    return json(res, 200, await getRevenueMetrics());
  }

  if (req.method === "POST" && url.pathname === "/v1/commercial/maintenance") {
    const body = await readJson(req);
    const limit = Math.min(
      Math.max(Math.trunc(Number(body.limit) || 100), 1),
      500,
    );
    return json(res, 200, await getCommercialMaintenance(limit));
  }

  return false;
}
