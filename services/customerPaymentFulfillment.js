const { Customer, Partner, Invoice } = require("../models/Index");
const CustomerPayment = require("../models/CustomerPayment");
const { generateCommissionForCustomerPayment } = require("./commissionEngine");
const { autoAssignVendorTier } = require("./tierAssignment");

/* ============================================================
   CUSTOMER PAYMENT FULFILLMENT
   Shared by both paths that can learn a Razorpay payment succeeded:
   - customerSubscriptionController.verifyCheckoutPayment, called by the
     customer's browser right after the Checkout popup succeeds.
   - razorpayWebhookController, Razorpay's own payment.captured event —
     the safety net for when the browser call never arrives (closed tab,
     network drop, etc).
   Both can fire for the same order, so the -> "paid" update below is a
   single atomic findOneAndUpdate: whichever call gets there first "claims"
   the payment and does the work, the other sees a null result and does
   nothing. Without this, a race between the two would apply the
   subscription change and generate commission twice.

   Claims from "created" OR "failed" (not just "created"): Razorpay
   Checkout lets a customer retry with a different payment method after a
   decline without closing the popup, all against the same order — an
   earlier declined attempt flips this row to "failed" (see
   recordCheckoutFailure), but the very next attempt on that same order can
   still succeed and must be claimable. Only "paid" is a truly terminal
   state.
============================================================ */

const applyPaidCustomerPayment = async (customerPaymentId, { razorpayPaymentId, method }, { req } = {}) => {
  const claimed = await CustomerPayment.findOneAndUpdate(
    { _id: customerPaymentId, status: { $in: ["created", "failed"] } },
    { $set: { status: "paid", "razorpay.paymentId": razorpayPaymentId, "razorpay.method": method || "" } },
    { returnDocument: "after" }
  );

  // Already processed by the other path (or doesn't exist) — nothing to do.
  if (!claimed) return null;

  const customer = await Customer.findById(claimed.customerId);
  if (!customer) return { customerPayment: claimed, customer: null };

  customer.subscription.status = "active";
  customer.subscription.screenCount = claimed.screenCount;
  customer.subscription.plan = claimed.plan;
  customer.subscription.durationMonths = claimed.durationMonths;
  customer.subscription.currentPeriodStart = claimed.period.start;
  customer.subscription.currentPeriodEnd = claimed.period.end;
  customer.subscription.scheduledChange = undefined;
  await customer.save();

  // The customer's receipt for this payment, shown on their Billing page —
  // for what they actually paid (GST included). Never allowed to undo a
  // payment that has already been taken and applied.
  try {
    await Invoice.create({
      customerId: customer._id,
      partnerId: claimed.partnerId,
      amount: claimed.amount.total,
      currency: claimed.amount.currency || "INR",
      status: "paid",
      issuedAt: new Date(),
      customerPaymentId: claimed._id
    });
  } catch (invoiceError) {
    console.error("applyPaidCustomerPayment: invoice could not be issued:", invoiceError.message);
  }

  if (claimed.amount.base > 0) {
    const partner = await Partner.findById(claimed.partnerId);

    if (partner) {
      // Commission is generated on the pre-GST base amount — GST is a
      // pass-through tax collected on the government's behalf, not
      // revenue the partner has any claim on.
      await generateCommissionForCustomerPayment({
        customer,
        revenue: claimed.amount.base,
        screenCount: claimed.screenCount,
        req
      });
      await autoAssignVendorTier(partner);
    }
  }

  claimed.commissionGenerated = true;
  await claimed.save();

  return { customerPayment: claimed, customer };
};

module.exports = { applyPaidCustomerPayment };
