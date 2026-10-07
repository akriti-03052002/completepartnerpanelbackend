const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   CUSTOMER PAYMENT
   One row per Razorpay order created from the customer subscription
   checkout (customerSubscriptionController). Created "created" the
   moment an order is opened, then flipped to "paid"/"failed" once
   Razorpay reports back — either via the customer's browser calling
   /verify right after Checkout succeeds, or via the /webhooks/razorpay
   safety net if that call never arrives. Never trust req.body for the
   amount or the plan/screenCount/period being applied — those are
   snapshotted here at order-creation time (server-computed) and reused
   as-is at fulfillment time (see services/customerPaymentFulfillment.js).
============================================================ */

const CustomerPaymentSchema = new Schema(
  {
    customerId: {
      type: ObjectId,
      ref: "Customer",
      required: true,
      index: true
    },

    // Denormalized so commission/reporting doesn't need to re-join through
    // Customer once the payment is old.
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    plan: {
      type: String,
      enum: ["basic", "premium"],
      required: true
    },

    screenCount: {
      type: Number,
      required: true
    },

    durationMonths: {
      type: Number,
      required: true
    },

    changeType: {
      type: String,
      enum: ["immediate", "deferred"],
      required: true
    },

    prorated: {
      type: Boolean,
      default: false
    },

    // amount.base is what commission is calculated on (excludes GST — GST
    // is a pass-through tax, not partner-eligible revenue).
    amount: {
      base: { type: Number, required: true },
      gstRatePercent: { type: Number, required: true },
      gst: { type: Number, required: true },
      total: { type: Number, required: true },
      currency: { type: String, default: "INR" }
    },

    // Billing-cycle window this payment activates, applied verbatim to
    // Customer.subscription on fulfillment.
    period: {
      start: { type: Date, required: true },
      end: { type: Date, required: true }
    },

    razorpay: {
      orderId: { type: String, index: true, unique: true, sparse: true },
      paymentId: { type: String, index: true, sparse: true },
      // Never returned by default — only needed transiently during
      // verification, no reason to expose it in any API response.
      signature: { type: String, select: false },
      method: { type: String, default: "" },
      failureCode: { type: String, default: "" },
      failureReason: { type: String, default: "" }
    },

    status: {
      type: String,
      enum: ["created", "paid", "failed"],
      default: "created",
      index: true
    },

    // Guards against generating commission twice if the webhook and the
    // browser's own /verify call both land (see applyPaidCustomerPayment's
    // atomic status:"created" -> "paid" claim, which this mirrors).
    commissionRecoveryError: { type: String, default: "" },
    commissionGenerated: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

CustomerPaymentSchema.index({ status: 1, commissionGenerated: 1, updatedAt: 1 });

module.exports = model("CustomerPayment", CustomerPaymentSchema);
