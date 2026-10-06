const ScreenLicensePurchaseOrder = require("../models/ScreenLicensePurchaseOrder");
const ResellerInvoice = require("../models/ResellerInvoice");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");
const PaymentClaim = require("../models/PaymentClaim");

/* ============================================================
   Guards every "offline" payment-verification path (an admin
   manually checking a claimed Razorpay payment ID against a bank
   transfer/reference) against the same real payment being applied
   twice — to two different orders, to a different partner's
   one-time prepayment, etc. The online checkout path doesn't need
   this: Razorpay's own orderId is unique per attempt and already
   enforced unique in our schema, so one Razorpay order can only
   ever be paid once. Offline entry has no such structural
   protection since the admin types the id in by hand — this is
   that protection.
============================================================ */

class PaymentAlreadyUsedError extends Error {
  constructor() {
    super("This payment has already been applied elsewhere — it can't be used again.");
    this.statusCode = 409;
  }
}

const assertPaymentNotReused = async (paymentId) => {
  if (!paymentId) return;

  const [existingOrder, existingInvoice, existingPrepayment] = await Promise.all([
    ScreenLicensePurchaseOrder.exists({ "razorpay.paymentId": paymentId }),
    ResellerInvoice.exists({ "razorpay.paymentId": paymentId }),
    ResellerBillingConfig.exists({ "prepayment.razorpay.paymentId": paymentId })
  ]);

  if (existingOrder || existingInvoice || existingPrepayment) {
    throw new PaymentAlreadyUsedError();
  }
};

module.exports = { assertPaymentNotReused, PaymentAlreadyUsedError };

// The unique payment ID serializes competing requests. The same target may
// retry after a failure; a different target can never claim this payment.
const claimPayment = async (paymentId, target) => {
  if (!paymentId) return;
  await PaymentClaim.init();
  const existing = await PaymentClaim.findById(paymentId);
  if (existing) {
    if (existing.target !== target) throw new PaymentAlreadyUsedError();
    return;
  }
  await assertPaymentNotReused(paymentId);
  try {
    await PaymentClaim.create({ _id: paymentId, target });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const owner = await PaymentClaim.findById(paymentId);
    if (owner?.target !== target) throw new PaymentAlreadyUsedError();
  }
};

module.exports.claimPayment = claimPayment;
