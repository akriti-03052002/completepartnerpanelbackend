const CustomerPayment = require("../models/CustomerPayment");
const { PartnerBankAccount } = require("../models/Index");
const ScreenLicensePurchaseOrder = require("../models/ScreenLicensePurchaseOrder");
const ResellerInvoice = require("../models/ResellerInvoice");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");
const { applyPaidCustomerPayment } = require("../services/customerPaymentFulfillment");
const { applyBankVerificationPayment } = require("../services/partnerBankVerification");
const { applyPaidLicenseOrder, markLicenseOrderFailed } = require("../services/resellerLicenseOrderFulfillment");
const { applyPaidInvoice, markInvoicePaymentFailed } = require("../services/resellerInvoicePaymentFulfillment");
const { applyPaidPrepayment } = require("../services/resellerPrepaymentFulfillment");
const { verifyWebhookSignature } = require("../utils/razorpay");

/* ============================================================
   RAZORPAY WEBHOOK
   Safety net for the customer subscription checkout: if the customer's
   browser closes (or the network drops) right after Checkout succeeds but
   before the app's own /verify call lands, this is what still gets the
   subscription activated and commission generated — Razorpay retries
   webhook delivery on failure, the browser call does not.

   (Partner settlement payouts are always Offline or Razorpay-verify,
   admin-initiated and admin-confirmed — there's no automated payout flow
   needing a webhook here.)

   Mounted in index.js with express.raw() BEFORE the global express.json()
   parser — the signature below is computed over the exact raw bytes
   Razorpay sent, so it must never be re-serialized through JSON.parse
   first.

   Configure this in the Razorpay Dashboard -> Webhooks:
     URL: <your API base>/api/webhooks/razorpay
     Secret: same value as RAZORPAY_WEBHOOK_SECRET in .env
     Events: payment.captured, payment.failed
     (also doubles as the safety net for the partner's ₹1 bank
     verification payment — distinguished from the customer subscription
     payment by payment.notes.purpose === "partner_bank_verification", see
     partnerBankController.initiateBankVerification — and for two Reseller
     payment purposes: "reseller_license_purchase" and
     "reseller_invoice_payment", see partnerLicenseOrderController and
     partnerResellerBillingController respectively)
============================================================ */

const handleRazorpayWebhook = async (req, res) => {
  const signature = req.headers["x-razorpay-signature"];

  if (!signature || !(await verifyWebhookSignature({ rawBody: req.body, signature }))) {
    return res.status(400).json({ success: false, message: "Invalid webhook signature." });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).json({ success: false, message: "Malformed webhook payload." });
  }

  try {
    if (event.event === "payment.captured") {
      const payment = event.payload?.payment?.entity;
      if (!payment?.order_id) return res.json({ success: true });

      if (payment.notes?.purpose === "partner_bank_verification") {
        const bankAccount = await PartnerBankAccount.findOne({
          $or: [{ "razorpayCheck.orderId": payment.order_id }, { "pendingChange.razorpayCheck.orderId": payment.order_id }]
        });
        if (bankAccount && payment.amount === 100) {
          await applyBankVerificationPayment(bankAccount, payment);
        }
        return res.json({ success: true });
      }

      if (payment.notes?.purpose === "reseller_license_purchase") {
        const purchaseOrder = await ScreenLicensePurchaseOrder.findOne({ "razorpay.orderId": payment.order_id });
        if (purchaseOrder && payment.amount === Math.round(purchaseOrder.pricing.totalAmount * 100)) {
          await applyPaidLicenseOrder(purchaseOrder._id, { razorpayPaymentId: payment.id, method: payment.method });
        }
        return res.json({ success: true });
      }

      if (payment.notes?.purpose === "reseller_invoice_payment") {
        const invoice = await ResellerInvoice.findOne({ "razorpay.orderId": payment.order_id });
        if (invoice && payment.amount === Math.round(invoice.total * 100)) {
          await applyPaidInvoice(invoice._id, { razorpayPaymentId: payment.id });
        }
        return res.json({ success: true });
      }

      if (payment.notes?.purpose === "reseller_prepayment") {
        const config = await ResellerBillingConfig.findOne({ "prepayment.razorpay.orderId": payment.order_id });
        if (config && payment.amount === Math.round(config.prepayment.amount * 100)) {
          await applyPaidPrepayment(config.partnerId, { razorpayPaymentId: payment.id, method: payment.method });
        }
        return res.json({ success: true });
      }

      const customerPayment = await CustomerPayment.findOne({ "razorpay.orderId": payment.order_id });
      // Amount mismatch would mean the order was tampered with somewhere
      // upstream of Razorpay's own records — refuse to fulfill rather than
      // trust it.
      if (customerPayment && payment.amount === Math.round(customerPayment.amount.total * 100)) {
        await applyPaidCustomerPayment(customerPayment._id, { razorpayPaymentId: payment.id, method: payment.method });
      }
    } else if (event.event === "payment.failed") {
      const payment = event.payload?.payment?.entity;
      if (!payment?.order_id) return res.json({ success: true });

      if (payment.notes?.purpose === "partner_bank_verification") {
        await PartnerBankAccount.findOneAndUpdate(
          { "razorpayCheck.orderId": payment.order_id, "razorpayCheck.paymentStatus": { $ne: "captured" } },
          {
            $set: {
              "razorpayCheck.paymentStatus": "failed",
              "razorpayCheck.failureReason": payment.error_description || "Payment failed."
            }
          }
        );
        // ...or the check on a Reseller's staged bank account change.
        await PartnerBankAccount.findOneAndUpdate(
          {
            "pendingChange.razorpayCheck.orderId": payment.order_id,
            "pendingChange.razorpayCheck.paymentStatus": { $ne: "captured" }
          },
          {
            $set: {
              "pendingChange.razorpayCheck.paymentStatus": "failed",
              "pendingChange.razorpayCheck.failureReason": payment.error_description || "Payment failed."
            }
          }
        );
        return res.json({ success: true });
      }

      if (payment.notes?.purpose === "reseller_license_purchase") {
        const purchaseOrder = await ScreenLicensePurchaseOrder.findOne({ "razorpay.orderId": payment.order_id });
        if (purchaseOrder) {
          await markLicenseOrderFailed(purchaseOrder._id, {
            failureCode: payment.error_code,
            failureReason: payment.error_description
          });
        }
        return res.json({ success: true });
      }

      if (payment.notes?.purpose === "reseller_invoice_payment") {
        const invoice = await ResellerInvoice.findOne({ "razorpay.orderId": payment.order_id });
        if (invoice) await markInvoicePaymentFailed(invoice._id);
        return res.json({ success: true });
      }

      if (payment.notes?.purpose === "reseller_prepayment") {
        await ResellerBillingConfig.findOneAndUpdate(
          {
            "prepayment.razorpay.orderId": payment.order_id,
            "prepayment.status": "awaiting_payment"
          },
          { $unset: { "prepayment.razorpay.orderId": 1 } }
        );
        return res.json({ success: true });
      }

      await CustomerPayment.findOneAndUpdate(
        { "razorpay.orderId": payment.order_id, status: "created" },
        {
          $set: {
            status: "failed",
            "razorpay.failureCode": payment.error_code || "",
            "razorpay.failureReason": payment.error_description || "Payment failed."
          }
        }
      );
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("handleRazorpayWebhook error:", error);
    // 500 so Razorpay retries delivery instead of treating this as handled.
    return res.status(500).json({ success: false, message: "Webhook processing failed." });
  }
};

module.exports = { handleRazorpayWebhook };
