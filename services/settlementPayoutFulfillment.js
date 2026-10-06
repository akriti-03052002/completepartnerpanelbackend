const { Partner, PartnerCommission, PartnerNotification, PartnerSettlement } = require("../models/Index");
const PartnerSettlementBill = require("../models/PartnerSettlementBill");
const logActivity = require("../utils/logActivity");
const mongoose = require("mongoose");
const PartnerSettlementHistory = require("../models/PartnerSettlementHistory");

/* ============================================================
   SETTLEMENT PAYOUT FULFILLMENT
   The one place that actually marks a PartnerSettlement "paid" and
   cascades the side effects (PartnerCommission rows -> "settled",
   Partner.stats, activity log, notification) — shared by both payment
   paths in adminSettlementController (offline, Razorpay-verify). Keeping
   this in one place is what guarantees the cascade can't drift between
   paths.

   payable.total (net + GST, if a verified bill exists) is what actually
   gets recorded as paid — see adminSettlementController.computePayableAmount.
============================================================ */

// Methods the settlement can store; anything else Razorpay might report
// is recorded as "other" rather than failing the whole payout.
const PAYMENT_METHODS = ["bank_transfer", "upi", "cheque", "cash", "other", "card", "netbanking", "wallet", "emi", "paylater"];

// `verifiedOnline` — the payment was checked against Razorpay / RazorpayX
// (as opposed to recorded on the admin's word); it decides how the history
// entry is labelled, independent of the payment method.
const finalizeSettlementPaid = async (settlement, { method, transactionId, paidAt, payableTotal, verifiedOnline = false, byUserId, req } = {}) => {
  const paidAmount = payableTotal ?? settlement.amount.net;
  const payment = {
    method: PAYMENT_METHODS.includes(method) ? method : (method ? "other" : "bank_transfer"),
    transactionId: transactionId || "",
    paidAt: paidAt || new Date()
  };
  const updated = await mongoose.connection.transaction(async (session) => {
    const claimed = await PartnerSettlement.findOneAndUpdate(
      { _id: settlement._id, status: "approved" },
      { $set: { status: "paid", payment, ...(settlement.cheque?.number ? { cheque: JSON.parse(JSON.stringify(settlement.cheque)) } : {}) } },
      { returnDocument: "after", session, runValidators: true }
    );
    if (!claimed) {
      const error = new Error("Settlement was already processed or is no longer approved.");
      error.statusCode = 409;
      throw error;
    }
    await PartnerCommission.updateMany(
      { _id: { $in: claimed.commissionIds } },
      { $set: { "settlement.status": "settled" } }, { session }
    );
    await Partner.updateOne({ _id: claimed.partnerId }, [{ $set: {
      "stats.paidCommission": { $add: [{ $ifNull: ["$stats.paidCommission", 0] }, paidAmount] },
      "stats.pendingCommission": { $max: [0, { $subtract: [{ $ifNull: ["$stats.pendingCommission", 0] }, claimed.amount.net] }] }
    } }], { session, updatePipeline: true });
    await PartnerSettlementHistory.create([{
      settlementId: claimed._id, partnerId: claimed.partnerId,
      action: verifiedOnline ? "paid_razorpay" : "paid_offline",
      fromStatus: "approved", toStatus: "paid",
      amount: { net: claimed.amount.net, gst: paidAmount - claimed.amount.net, total: paidAmount, currency: claimed.amount.currency },
      meta: { method, transactionId }, performedByType: byUserId ? "spotx_user" : "system",
      performedByUserId: byUserId, ipAddress: req?.ip || ""
    }], { session });
    return claimed;
  });
  settlement.status = updated.status;
  settlement.payment = updated.payment;

  await logActivity({
    partnerId: settlement.partnerId,
    performedByType: byUserId ? "spotx_user" : "system",
    performedByUserId: byUserId,
    activityType: "settlement_paid",
    entityType: "PartnerSettlement",
    entityId: settlement._id,
    description: `Settlement ${settlement.settlementNumber} marked paid.`,
    req
  }).catch((error) => console.error("Settlement activity logging failed:", error.message));

  await PartnerNotification.create({
    partnerId: settlement.partnerId,
    type: "settlement_paid",
    title: "Payout completed",
    message: `Your settlement of ${paidAmount.toFixed(2)} has been paid.`,
    entity: { type: "PartnerSettlement", entityId: settlement._id }
  }).catch((error) => console.error("finalizeSettlementPaid: notification failed:", error.message));

  return settlement;
};

// net-of-TDS commission + GST from a verified bill (if the partner is
// GST-registered and one exists) — this is what's actually payable, as
// opposed to settlement.amount.net which is pre-GST commission math only.
const computePayableAmount = async (settlement) => {
  const bill = await PartnerSettlementBill.findOne({ settlementId: settlement._id, status: "verified" });
  const gst = bill?.amount?.gstAmount || 0;
  return { net: settlement.amount.net, gst, total: Math.round((settlement.amount.net + gst) * 100) / 100 };
};

module.exports = { finalizeSettlementPaid, computePayableAmount };
