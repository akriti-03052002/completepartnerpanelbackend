const { claimPayment } = require("../utils/assertPaymentNotReused");
const ResellerInvoice = require("../models/ResellerInvoice");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");

/* ============================================================
   RESELLER INVOICE PAYMENT FULFILLMENT
   Same atomic-claim discipline as resellerLicenseOrderFulfillment —
   shared by /verify and the webhook. Paying an invoice never
   touches ResellerInventory; the purchased-license count this
   invoice was billed on is already frozen in
   purchasedLicenseSnapshot regardless of payment outcome.
============================================================ */

const applyPaidInvoice = async (invoiceId, { razorpayPaymentId, offlinePayment } = {}) => {
  await claimPayment(razorpayPaymentId, `invoice:${invoiceId}`);
  const invoice = await ResellerInvoice.findOneAndUpdate(
    { _id: invoiceId, paymentStatus: { $in: ["pending", "overdue", "failed"] } },
    {
      $set: {
        paymentStatus: "paid",
        paidAt: new Date(),
        ...(razorpayPaymentId ? { "razorpay.paymentId": razorpayPaymentId } : {}),
        ...(offlinePayment ? { offlinePayment, paymentMode: "offline" } : {}),
        ...(offlinePayment?.method === "cheque" ? { "cheque.status": "cleared", "cheque.number": offlinePayment.transactionId, "cheque.updatedAt": new Date(), "cheque.updatedBy": offlinePayment.verifiedBy } : {})
      },
      $push: { paymentHistory: { action: "paid", method: offlinePayment?.method || "razorpay", reference: offlinePayment?.transactionId || razorpayPaymentId, recordedBy: offlinePayment?.verifiedBy, recordedAt: new Date() } }
    },
    { new: true }
  );

  if (!invoice) return null;

  await logActivity({
    partnerId: invoice.partnerId,
    performedByType: "system",
    activityType: "reseller_payment_success",
    entityType: "ResellerInvoice",
    entityId: invoice._id,
    description: `Invoice ${invoice.invoiceNumber} paid — ${invoice.total}.`
  });

  await notifyPartner({
    partnerId: invoice.partnerId,
    type: "reseller_invoice_paid",
    title: "Invoice payment received",
    message: `SPOTX received your payment of ${notifyPartner.rupees(invoice.total)} for invoice ${invoice.invoiceNumber}.`,
    entityType: "ResellerInvoice",
    entityId: invoice._id
  });

  return invoice;
};

const markInvoicePaymentFailed = async (invoiceId) => {
  const invoice = await ResellerInvoice.findOneAndUpdate(
    { _id: invoiceId, paymentStatus: { $ne: "paid" } },
    { $set: { paymentStatus: "failed" } },
    { new: true }
  );

  if (invoice) {
    await logActivity({
      partnerId: invoice.partnerId,
      performedByType: "system",
      activityType: "reseller_payment_failed",
      entityType: "ResellerInvoice",
      entityId: invoice._id,
      description: `Payment attempt failed for invoice ${invoice.invoiceNumber}.`
    });

    await notifyPartner({
      partnerId: invoice.partnerId,
      type: "reseller_invoice_payment_failed",
      title: "Invoice payment failed",
      message: `Your payment for invoice ${invoice.invoiceNumber} did not go through. Try again from Billing & Payments.`,
      entityType: "ResellerInvoice",
      entityId: invoice._id
    });
  }

  return invoice;
};

module.exports = { applyPaidInvoice, markInvoicePaymentFailed };
