const { Partner, PartnerBankAccount, PartnerDocument, PartnerSettlement, PartnerNotification } = require("../models/Index");
const PartnerSettlementBill = require("../models/PartnerSettlementBill");
const logActivity = require("./logActivity");
const { recordSettlementHistory } = require("./settlementHistory");
const { SETTLEMENT_HOLD_CODES } = require("../config/constant");
const { getRequiredDocumentTypes } = require("./partnerVerification");

/* ============================================================
   SETTLEMENT HOLD
   Central place for putting settlements on hold / releasing them, and
   for deciding whether a partner is currently payout-eligible at all.
   "on_hold" isn't a dead end — hold.previousStatus + hold.code are what
   let release restore the right state instead of guessing, and what let
   release refuse to fire until the actual cause is gone.
============================================================ */

// Statuses a settlement can be swept out of into a hold. Once paid/failed/
// cancelled/on_hold, holding again either doesn't apply or must go through
// the dedicated release/retry path instead.
const HOLDABLE_STATUSES = ["draft", "pending_approval", "approved", "processing"];

const HOLD_REASON_LABEL = {
  bank_unverified: "Partner's bank account is not verified.",
  bank_change_pending: "Bank details were recently changed and the new account is pending verification.",
  partner_suspended: "Partner account is suspended.",
  compliance_review: "Partner account is under compliance review.",
  incomplete_info: "Required settlement/payout information is incomplete.",
  manual: "On hold."
};

/* Partner + bank state only — doesn't look at any one settlement. Used
   before creating/approving/paying a settlement to decide if it should
   go through or land on hold instead. */
const checkPartnerPayoutEligibility = async (partnerId) => {
  const partner = await Partner.findById(partnerId);

  if (!partner) {
    return { eligible: false, code: "incomplete_info", reason: "Partner record not found." };
  }

  if (partner.status === "suspended") {
    return { eligible: false, code: "partner_suspended", reason: HOLD_REASON_LABEL.partner_suspended };
  }

  if (partner.status === "under_review") {
    return { eligible: false, code: "compliance_review", reason: HOLD_REASON_LABEL.compliance_review };
  }

  if (partner.status !== "active") {
    return { eligible: false, code: "incomplete_info", reason: `Partner account is ${partner.status.replace(/_/g, " ")}.` };
  }

  const bankAccount = await PartnerBankAccount.findOne({ partnerId });

  if (!bankAccount) {
    return { eligible: false, code: "incomplete_info", reason: "No bank account on file for this partner." };
  }

  if (bankAccount.verification.status !== "verified") {
    return { eligible: false, code: "bank_unverified", reason: HOLD_REASON_LABEL.bank_unverified };
  }

  return { eligible: true };
};

/* GST-registered partners (business types whose required KYC includes a
   verified "gst_certificate" — see utils/partnerVerification.js) must
   submit a bill for a settlement batch before it can be paid: what's
   actually owed is commission + GST, not just the raw commission amount.
   Checked independently of checkPartnerPayoutEligibility (which only
   looks at partner/bank state, not any one settlement) since this is
   scoped to a specific settlementId. */
const checkBillRequirement = async (partnerId, settlementId) => {
  const partner = await Partner.findById(partnerId);
  if (!partner) return { eligible: true }; // checkPartnerPayoutEligibility already reports "not found"

  const gstRequired = getRequiredDocumentTypes(partner.partnerType).includes("gst_certificate");
  if (!gstRequired) return { eligible: true };

  const verifiedGstDoc = await PartnerDocument.findOne({
    partnerId,
    documentType: "gst_certificate",
    "verification.status": "verified"
  });
  if (!verifiedGstDoc) return { eligible: true }; // GST-eligible type, but not actually GST-registered — nothing to bill

  const bill = await PartnerSettlementBill.findOne({ settlementId });

  if (!bill) {
    return {
      eligible: false,
      code: "incomplete_info",
      reason: "GST-registered — a bill must be submitted for this settlement before it can be paid."
    };
  }

  if (bill.status !== "verified") {
    return {
      eligible: false,
      code: "incomplete_info",
      reason: bill.status === "rejected"
        ? `The submitted bill was rejected: ${bill.rejectionReason || "no reason given"}. A new bill must be submitted.`
        : "A bill has been submitted for this settlement but not yet verified."
    };
  }

  return { eligible: true };
};

/* Combines the partner/bank-level check with the settlement-scoped bill
   check — the one function every settlement-mutating action (create,
   approve, and all three payment paths) should call, so none of them can
   independently forget one half of the gate. */
const checkSettlementPayoutReadiness = async (settlement) => {
  const partnerEligibility = await checkPartnerPayoutEligibility(settlement.partnerId);
  if (!partnerEligibility.eligible) return partnerEligibility;

  return checkBillRequirement(settlement.partnerId, settlement._id);
};

const notifyPartner = (partnerId, { type, title, message, entityId }) =>
  PartnerNotification.create({
    partnerId,
    type,
    title,
    message,
    entity: { type: "PartnerSettlement", entityId }
  }).catch((error) => console.error("settlementHold: notification failed:", error.message));

/* Puts a single settlement on hold, saving whatever status it was in so
   releaseSettlementHold can restore it later instead of guessing.
   byUserId omitted => logged/notified as a system-triggered hold. */
const putSettlementOnHold = async (settlement, { code, reason, byUserId, req } = {}) => {
  const resolvedCode = SETTLEMENT_HOLD_CODES.includes(code) ? code : "manual";
  const resolvedReason = reason || HOLD_REASON_LABEL[resolvedCode] || "On hold.";
  const fromStatus = settlement.status;

  settlement.hold = {
    code: resolvedCode,
    reason: resolvedReason,
    previousStatus: settlement.status,
    heldBy: byUserId || undefined,
    heldAt: new Date(),
    releasedBy: undefined,
    releasedAt: undefined
  };
  settlement.status = "on_hold";
  await settlement.save();

  await recordSettlementHistory(settlement, {
    action: "held",
    fromStatus,
    toStatus: "on_hold",
    reason: resolvedReason,
    meta: { code: resolvedCode },
    byUserId,
    req
  });

  await logActivity({
    partnerId: settlement.partnerId,
    performedByType: byUserId ? "spotx_user" : "system",
    performedByUserId: byUserId,
    activityType: "settlement_held",
    entityType: "PartnerSettlement",
    entityId: settlement._id,
    description: `Settlement ${settlement.settlementNumber} put on hold: ${resolvedReason}`,
    req
  });

  await notifyPartner(settlement.partnerId, {
    type: "settlement_held",
    title: "Settlement on hold",
    message: `Your settlement ${settlement.settlementNumber} of ${settlement.amount.net.toFixed(2)} is on hold: ${resolvedReason}`,
    entityId: settlement._id
  });

  return settlement;
};

/* Bulk version — used when the root cause is partner-level (suspension,
   compliance review, a bank-detail change) rather than about one
   settlement someone is reviewing individually. */
const holdSettlementsForPartner = async (partnerId, { code, reason, byUserId, req } = {}) => {
  const settlements = await PartnerSettlement.find({
    partnerId,
    status: { $in: HOLDABLE_STATUSES }
  });

  for (const settlement of settlements) {
    await putSettlementOnHold(settlement, { code, reason, byUserId, req });
  }

  return settlements;
};

class HoldReleaseError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

/* Releases a hold — but only once the condition that caused it is
   actually gone. An admin can't just wish a bank account verified or a
   partner reactivated; compliance_review/incomplete_info/manual have no
   objective check and are released purely at the admin's discretion. */
const releaseSettlementHold = async (settlement, { byUserId, req } = {}) => {
  const code = settlement.hold?.code;

  if (code === "bank_unverified" || code === "bank_change_pending") {
    const bankAccount = await PartnerBankAccount.findOne({ partnerId: settlement.partnerId });
    if (!bankAccount || bankAccount.verification.status !== "verified") {
      throw new HoldReleaseError("The partner's bank account still isn't verified — verify it before releasing this hold.");
    }
  }

  if (code === "partner_suspended") {
    const partner = await Partner.findById(settlement.partnerId);
    if (!partner || partner.status !== "active") {
      throw new HoldReleaseError("This partner is still suspended — reactivate the partner before releasing this hold.");
    }
  }

  const toStatus = settlement.hold?.previousStatus || "pending_approval";
  settlement.status = toStatus;
  settlement.hold.releasedBy = byUserId || undefined;
  settlement.hold.releasedAt = new Date();
  await settlement.save();

  await recordSettlementHistory(settlement, {
    action: "released",
    fromStatus: "on_hold",
    toStatus,
    byUserId,
    req
  });

  await logActivity({
    partnerId: settlement.partnerId,
    performedByType: byUserId ? "spotx_user" : "system",
    performedByUserId: byUserId,
    activityType: "settlement_released",
    entityType: "PartnerSettlement",
    entityId: settlement._id,
    description: `Settlement ${settlement.settlementNumber} released from hold.`,
    req
  });

  await notifyPartner(settlement.partnerId, {
    type: "settlement_released",
    title: "Settlement hold released",
    message: `Your settlement ${settlement.settlementNumber} is no longer on hold.`,
    entityId: settlement._id
  });

  return settlement;
};

/* Auto-release path for objective causes only — e.g. right after an
   admin re-verifies a bank account. Any settlement whose root cause
   isn't actually resolved yet is silently left on hold. */
const releaseSettlementsForPartnerByCodes = async (partnerId, codes, { byUserId, req } = {}) => {
  const settlements = await PartnerSettlement.find({
    partnerId,
    status: "on_hold",
    "hold.code": { $in: codes }
  });

  const released = [];
  for (const settlement of settlements) {
    try {
      await releaseSettlementHold(settlement, { byUserId, req });
      released.push(settlement);
    } catch (error) {
      // Root cause not actually resolved for this one yet — leave it held.
    }
  }
  return released;
};

module.exports = {
  HOLD_REASON_LABEL,
  HoldReleaseError,
  checkPartnerPayoutEligibility,
  checkBillRequirement,
  checkSettlementPayoutReadiness,
  putSettlementOnHold,
  holdSettlementsForPartner,
  releaseSettlementHold,
  releaseSettlementsForPartnerByCodes
};
