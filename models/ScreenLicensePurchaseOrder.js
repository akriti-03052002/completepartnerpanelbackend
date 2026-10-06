const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   SCREEN LICENSE PURCHASE ORDER
   One immutable row per bulk license purchase by a Reseller
   partner. Mirrors CustomerPayment's discipline: server-computed
   amount snapshot, never trust the frontend, status flips from
   "created" to "paid"/"failed" only via the Razorpay webhook (see
   razorpayWebhookController's "reseller_license_purchase" branch)
   or the browser's own /verify call as a UX shortcut — the webhook
   remains authoritative either way.

   Never edited after creation. Every additional purchase is a new
   row — the original order is never modified to add more licenses.
============================================================ */

const ScreenLicensePurchaseOrderSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    quantity: {
      type: Number,
      required: true,
      min: 1
    },

    // Snapshotted from ResellerPricingPlan at order-creation time — a
    // later change to the partner's rate/mode never touches this record.
    pricing: {
      standardUnitPrice: { type: Number, required: true },
      pricingMode: { type: String, enum: ["discount_percent", "fixed_price"], required: true },
      wholesaleDiscountPercent: { type: Number },
      fixedUnitPrice: { type: Number },
      unitPrice: { type: Number, required: true },
      subtotal: { type: Number, required: true },
      taxRatePercent: { type: Number, required: true },
      taxAmount: { type: Number, required: true },
      discount: { type: Number, default: 0 },
      totalAmount: { type: Number, required: true },
      currency: { type: String, default: "INR" }
    },

    pricingPlanId: {
      type: ObjectId,
      ref: "ResellerPricingPlan"
    },

    razorpay: {
      orderId: { type: String, index: true, unique: true, sparse: true },
      paymentId: { type: String, index: true, sparse: true },
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

    // A purchase is now a request-then-approve flow, not an instant
    // self-serve checkout: the reseller requests a quantity, SPOTX reviews
    // and picks how the reseller will pay (online via Razorpay, or an
    // offline transfer SPOTX verifies against a transaction reference),
    // and only then does payment/fulfillment happen.
    //   requested                    -> awaiting admin decision
    //   rejected                     -> admin declined the request
    //   awaiting_payment             -> approved for online payment, partner hasn't paid yet
    //   awaiting_offline_reference   -> approved for offline payment, partner hasn't submitted a reference yet
    //   offline_reference_submitted  -> partner submitted a reference, admin hasn't reviewed it yet
    //   completed                    -> paid (online or offline-verified) and licenses applied
    //   payment_failed                -> online payment attempt failed
    orderStatus: {
      type: String,
      enum: [
        "requested", "rejected",
        "awaiting_payment",
        "awaiting_offline_reference", "offline_reference_submitted",
        "completed", "payment_failed"
      ],
      default: "requested"
    },

    paymentMode: {
      type: String,
      enum: ["online", "offline"]
    },

    approval: {
      approvedBy: { type: ObjectId, ref: "User" },
      approvedAt: { type: Date },
      rejectedBy: { type: ObjectId, ref: "User" },
      rejectedAt: { type: Date },
      rejectionReason: { type: String, default: "" }
    },

    // Only relevant when paymentMode = "offline" — the reseller's own
    // reference for a payment made outside Razorpay (e.g. bank transfer),
    // which an admin checks and either verifies (licenses applied) or
    // rejects (partner can submit a corrected reference).
    offlinePayment: {
      transactionId: { type: String, default: "" },
      submittedAt: { type: Date },
      reviewedBy: { type: ObjectId, ref: "User" },
      reviewedAt: { type: Date },
      reviewRejectionReason: { type: String, default: "" }
    },

    // Atomic claim guard — mirrors CustomerPayment.commissionGenerated —
    // stops a retried webhook from adding purchased licenses twice.
    // This purchase's own bill, locked when the order is approved: its
    // cycle starts on startDate (the day the licences were bought) and it
    // is invoiced cycleAmount (+ tax) at the start of every cycle — see
    // services/resellerBilling.js. termAmount is the 12-month total.
    billing: {
      cycle: { type: String, enum: ["monthly", "quarterly", "yearly"] },
      cycleMonths: { type: Number },
      termMonths: { type: Number },
      startDate: { type: Date },
      monthlyAmount: { type: Number },
      cycleAmount: { type: Number },
      termAmount: { type: Number },
      dueDays: { type: Number },
      // Only on orders from before per-purchase billing: cycles starting
      // before this date were already paid on an old combined invoice.
      legacyCoveredUntil: { type: Date }
    },

    licensesApplied: {
      type: Boolean,
      default: false
    },

    orderCode: {
      type: String,
      trim: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = model("ScreenLicensePurchaseOrder", ScreenLicensePurchaseOrderSchema);
