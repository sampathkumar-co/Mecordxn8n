import {
  decideApprovalRequest,
  getApprovalRequest,
  markReportApproved,
} from "../milestone-b/repository.js";
import { queueApprovedRemediation } from "../milestone-b/routes.js";
import {
  activateCommercialAction,
  rejectCommercialAction,
  reconcileExpiredCommercialApprovals,
} from "../milestone-c/repository.js";

function conflict(code, message) {
  const error = new Error(message);
  error.statusCode = 409;
  error.code = code;
  throw error;
}

export async function decidePlatformApproval({
  approvalId,
  decision,
  decidedBy,
  decisionNote = null,
}) {
  const current = await getApprovalRequest(approvalId);
  if (!current) {
    const error = new Error("approval not found");
    error.statusCode = 404;
    error.code = "APPROVAL_NOT_FOUND";
    throw error;
  }

  const result = await decideApprovalRequest({
    approvalId,
    decision,
    decidedBy,
    decisionNote,
  });

  if (result.status === "NOT_FOUND") {
    const error = new Error("approval not found");
    error.statusCode = 404;
    error.code = "APPROVAL_NOT_FOUND";
    throw error;
  }
  if (
    result.status === "EXPIRED" ||
    (result.status === "ALREADY_DECIDED" &&
      result.approval.status === "EXPIRED")
  ) {
    if (result.approval.actionType === "OUTBOUND_CONTACT") {
      await reconcileExpiredCommercialApprovals(20);
    }
    conflict("APPROVAL_EXPIRED", "approval has expired");
  }

  const approval = result.approval;
  if (result.status === "ALREADY_DECIDED") {
    if (approval.status !== decision) {
      conflict(
        "APPROVAL_ALREADY_DECIDED",
        "approval has already received the opposite decision",
      );
    }

    if (decision === "REJECTED") {
      if (approval.actionType === "OUTBOUND_CONTACT") {
        return {
          approval,
          action: await rejectCommercialAction({
            actionId: approval.commercialActionId,
            approvalId: approval.id,
          }),
          idempotentReplay: true,
        };
      }
      return { approval, idempotentReplay: true };
    }

    if (approval.actionType === "SOURCE_REMEDIATION") {
      return {
        approval,
        ...(await queueApprovedRemediation(approval)),
        idempotentReplay: true,
      };
    }
    if (approval.actionType === "REPORT_RELEASE") {
      const report = await markReportApproved(approval.reportId);
      if (!report) conflict("REPORT_NOT_RELEASABLE", "report cannot be released");
      return { approval, report, idempotentReplay: true };
    }
    if (approval.actionType === "OUTBOUND_CONTACT") {
      const activation = await activateCommercialAction({
        actionId: approval.commercialActionId,
        approvalId: approval.id,
      });
      if (!activation.ok) conflict(activation.code, "outbound activation blocked");
      return {
        approval,
        action: activation.action,
        idempotentReplay: true,
      };
    }
    return { approval, idempotentReplay: true };
  }

  if (decision === "REJECTED") {
    if (approval.actionType === "OUTBOUND_CONTACT") {
      return {
        approval,
        action: await rejectCommercialAction({
          actionId: approval.commercialActionId,
          approvalId: approval.id,
        }),
      };
    }
    return { approval };
  }

  if (approval.actionType === "SOURCE_REMEDIATION") {
    return {
      approval,
      ...(await queueApprovedRemediation(approval)),
    };
  }
  if (approval.actionType === "REPORT_RELEASE") {
    const report = await markReportApproved(approval.reportId);
    if (!report) conflict("REPORT_NOT_RELEASABLE", "report cannot be released");
    return { approval, report };
  }
  if (approval.actionType === "OUTBOUND_CONTACT") {
    const activation = await activateCommercialAction({
      actionId: approval.commercialActionId,
      approvalId: approval.id,
    });
    if (!activation.ok) conflict(activation.code, "outbound activation blocked");
    return { approval, action: activation.action };
  }

  return { approval };
}
