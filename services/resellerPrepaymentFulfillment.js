const { claimPayment } = require("../utils/assertPaymentNotReused");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");

/* ============================================================
   RESELLER PREPAYMENT FULFILLMENT
   Same atomic-claim discipline as resellerInvoicePaymentFulfillment
   and resellerLicenseOrderFulfillment — shared by the online
   /verify call, the offline admin-verify path, and the Razorpay
   webhook. The claim is on prepayment.status rather than a
   dedicated document id, since ResellerBillingConfig (and its
   embedded prepayment) is one-per-partner, not one-per-transaction.
============================================================ */

const applyPaidPrepayment = async (partnerId, { razorpayPaymentId, method } = {}) => {
  await claimPayment(razorpayPaymentId, `prepayment:${partnerId}`);
  const config = await ResellerBillingConfig.findOneAndUpdate(
    { partnerId, "prepayment.status": "awaiting_payment" },
    {
      $set: {
        "prepayment.status": "done",
        "prepayment.paidAt": new Date(),
        "prepayment.razorpay.paymentId": razorpayPaymentId || "",
        "prepayment.razorpay.method": method || ""
      }
    },
    { new: true }
  );

  if (!config) return null;

  await logActivity({
    partnerId,
    performedByType: "system",
    activityType: "reseller_payment_success",
    entityType: "ResellerBillingConfig",
    entityId: config._id,
    description: `One-time prepayment of ${config.prepayment.amount} completed — license purchases are now unlocked.`
  });

  await notifyPartner({
    partnerId,
    type: "prepayment_done",
    title: "Prepayment received",
    message: `SPOTX received your one-time prepayment of ${notifyPartner.rupees(config.prepayment.amount)}. You can now request licenses and add customers.`,
    entityType: "ResellerBillingConfig",
    entityId: config._id
  });

  return config;
};

module.exports = { applyPaidPrepayment };
