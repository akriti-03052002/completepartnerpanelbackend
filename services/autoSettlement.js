const { PartnerCommission, PartnerSettlement, SettlementSetting } = require("../models/Index");
const PartnerSettlementBill = require("../models/PartnerSettlementBill");
const { generateSettlementNumber } = require("../utils/generateCode");
const logActivity = require("../utils/logActivity");
const { recordSettlementHistory } = require("../utils/settlementHistory");
const { checkSettlementPayoutReadiness, putSettlementOnHold } = require("../utils/settlementHold");
const notifyPartner = require("../utils/notifyPartner");
const { earningNounFor, rupees } = notifyPartner;

/* ============================================================
   AUTOMATIC SETTLEMENTS
   There is no "create settlement" step. The moment a commission
   (a content earning, referral reward or vendor commission) is
   APPROVED it is put into a settlement that is ready to pay:

   - If the partner already has an open settlement — not yet paid,
     and with no GST bill submitted against it — the commission is
     added to that one and its totals are recalculated.
   - Otherwise a new settlement is opened, already approved (the
     commission's approval IS the approval).

   So the admin's whole job is: approve the commission, then mark
   the settlement paid. If the batch can't safely be paid yet (bank
   not verified, partner suspended, a GST bill still needed) it is
   put on hold with the reason, exactly as before.
============================================================ */

// A settlement new commissions can still join.
const OPEN_STATUSES = ["draft", "pending_approval", "approved", "on_hold"];

// Gross, TDS and net for a set of commissions, from the partner's own
// settlement settings.
const computeAmounts = async (partnerId, commissionIds) => {
  const [commissions, setting] = await Promise.all([
    PartnerCommission.find({ _id: { $in: commissionIds } }).select("calculation.netCommission"),
    SettlementSetting.findOne({ partnerId })
  ]);

  const gross = commissions.reduce((sum, c) => sum + (c.calculation?.netCommission || 0), 0);
  const tdsRate = setting?.tax?.tdsEnabled ? setting.tax.tdsRate : 0;
  const tdsAmount = (gross * tdsRate) / 100;

  return {
    amount: { gross, deductions: tdsAmount, net: gross - tdsAmount, currency: "INR" },
    tax: { tdsRate, tdsAmount },
    settlementType: setting?.settlementType || "manual"
  };
};

// The partner's open settlement that has no bill against it yet. Once a
// bill is submitted the batch's amount is fixed (the bill is for exactly
// that amount), so anything approved later starts a new batch.
const findOpenSettlement = async (partnerId) => {
  const candidates = await PartnerSettlement.find({ partnerId, status: { $in: OPEN_STATUSES } }).sort({ createdAt: -1 });

  for (const settlement of candidates) {
    // eslint-disable-next-line no-await-in-loop
    const bill = await PartnerSettlementBill.findOne({ settlementId: settlement._id, status: { $ne: "rejected" } }).select("_id");
    if (!bill) return settlement;
  }

  return null;
};

/**
 * Puts a just-approved commission into a settlement. Returns
 * { settlement, created } — `created` is false when it joined an
 * existing open batch.
 */
const settleApprovedCommission = async (commission, { byUserId, req } = {}) => {
  const partnerId = commission.partnerId;
  let settlement = await findOpenSettlement(partnerId);
  const created = !settlement;

  if (created) {
    const totals = await computeAmounts(partnerId, [commission._id]);
    settlement = await PartnerSettlement.create({
      settlementNumber: generateSettlementNumber(),
      partnerId,
      commissionIds: [commission._id],
      settlementType: totals.settlementType,
      amount: totals.amount,
      tax: totals.tax,
      status: "approved",
      approvedBy: byUserId,
      approvedAt: new Date()
    });
  } else {
    if (!settlement.commissionIds.some((id) => String(id) === String(commission._id))) {
      settlement.commissionIds.push(commission._id);
    }
    const totals = await computeAmounts(partnerId, settlement.commissionIds);
    settlement.amount = totals.amount;
    settlement.tax = totals.tax;
    // A batch drafted the old way is approved by this approval too.
    if (["draft", "pending_approval"].includes(settlement.status)) {
      settlement.status = "approved";
      settlement.approvedBy = byUserId;
      settlement.approvedAt = new Date();
    }
    await settlement.save();
  }

  commission.settlement.status = "eligible";
  commission.settlement.settlementId = settlement._id;
  await commission.save();

  await recordSettlementHistory(settlement, {
    action: created ? "created" : "commission_added",
    toStatus: settlement.status,
    amount: { net: settlement.amount.net, gst: 0, total: settlement.amount.net, currency: "INR" },
    meta: { commissionCount: settlement.commissionIds.length, commissionId: commission._id, automatic: true },
    byUserId,
    req
  });

  await logActivity({
    partnerId,
    performedByType: byUserId ? "spotx_user" : "system",
    performedByUserId: byUserId,
    activityType: "settlement_created",
    entityType: "PartnerSettlement",
    entityId: settlement._id,
    description: created
      ? `Settlement ${settlement.settlementNumber} opened automatically for an approved commission (${settlement.amount.net.toFixed(2)}).`
      : `An approved commission was added to settlement ${settlement.settlementNumber} (now ${settlement.amount.net.toFixed(2)}).`,
    req
  });

  const noun = await earningNounFor(partnerId);
  await notifyPartner({
    partnerId,
    type: "settlement_created",
    title: created ? "Settlement created" : "Settlement updated",
    message: created
      ? `Settlement ${settlement.settlementNumber} was opened for your approved ${noun}: ${rupees(settlement.amount.net)}. It will be paid to your bank account.`
      : `Settlement ${settlement.settlementNumber} now covers ${settlement.commissionIds.length} ${noun}s totalling ${rupees(settlement.amount.net)}.`,
    entityType: "PartnerSettlement",
    entityId: settlement._id
  });

  // Can it actually be paid yet? If not, hold it with the reason rather
  // than leave a payable-looking batch the admin can't pay.
  if (settlement.status !== "on_hold") {
    const eligibility = await checkSettlementPayoutReadiness(settlement);
    if (!eligibility.eligible) {
      await putSettlementOnHold(settlement, { code: eligibility.code, reason: eligibility.reason, byUserId, req });
    }
  }

  return { settlement, created };
};

/**
 * Takes a commission back out of its unpaid settlement (it was put on hold
 * or reversed). Recalculates the batch, or cancels it if that was its only
 * commission. Returns { ok: false, message } when it can't be removed.
 */
const removeCommissionFromSettlement = async (commission, { byUserId, req } = {}) => {
  const settlementId = commission.settlement?.settlementId;
  if (!settlementId) return { ok: true, settlement: null };

  const settlement = await PartnerSettlement.findById(settlementId);
  if (!settlement) return { ok: true, settlement: null };

  if (!OPEN_STATUSES.includes(settlement.status)) {
    return { ok: false, message: `This commission is in settlement ${settlement.settlementNumber}, which is already ${settlement.status}.` };
  }

  const bill = await PartnerSettlementBill.findOne({ settlementId: settlement._id, status: { $ne: "rejected" } }).select("_id");
  if (bill) {
    return {
      ok: false,
      message: `Settlement ${settlement.settlementNumber} already has a bill submitted for its full amount. Put the settlement itself on hold instead.`
    };
  }

  settlement.commissionIds = settlement.commissionIds.filter((id) => String(id) !== String(commission._id));

  if (settlement.commissionIds.length === 0) {
    settlement.amount = { gross: 0, deductions: 0, net: 0, currency: "INR" };
    settlement.tax = { tdsRate: settlement.tax?.tdsRate || 0, tdsAmount: 0 };
    settlement.status = "cancelled";
  } else {
    const totals = await computeAmounts(settlement.partnerId, settlement.commissionIds);
    settlement.amount = totals.amount;
    settlement.tax = totals.tax;
  }
  await settlement.save();

  await recordSettlementHistory(settlement, {
    action: "commission_removed",
    toStatus: settlement.status,
    amount: { net: settlement.amount.net, gst: 0, total: settlement.amount.net, currency: "INR" },
    meta: { commissionCount: settlement.commissionIds.length, commissionId: commission._id },
    byUserId,
    req
  });

  commission.settlement.settlementId = undefined;

  return { ok: true, settlement };
};

/**
 * Catches up anything approved before settlements became automatic: every
 * commission still sitting at "approved" with no settlement gets one. Safe
 * to run any number of times.
 */
const settleAllApprovedCommissions = async () => {
  const waiting = await PartnerCommission.find({ "settlement.status": "approved" }).sort({ createdAt: 1 });
  let settled = 0;

  for (const commission of waiting) {
    if (!commission.partnerId) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await settleApprovedCommission(commission);
      settled += 1;
    } catch (error) {
      console.error(`settleAllApprovedCommissions: commission ${commission._id} failed:`, error.message);
    }
  }

  return settled;
};

module.exports = {
  settleApprovedCommission,
  removeCommissionFromSettlement,
  settleAllApprovedCommissions,
  findOpenSettlement
};
