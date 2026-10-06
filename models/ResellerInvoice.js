const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const { RESELLER_BILLING_CYCLES } = require("../config/constant");

/* ============================================================
   RESELLER INVOICE
   SPOTX's bill to a Reseller partner — the reverse money direction
   from PartnerSettlement (which is SPOTX paying a partner). Each
   licence purchase is billed on its own: one invoice per purchase
   per billing cycle, raised on the first day of the cycle, for that
   purchase's quantity at the price locked when it was bought — see
   services/resellerBilling.js. An invoice is never changed once
   raised.
============================================================ */

const ResellerInvoiceSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    // The purchase this invoice bills, and which instalment of its
    // 12-month term it is ("2 of 4" on a quarterly cycle). Absent only on
    // invoices from the old one-combined-bill-per-calendar-cycle scheme.
    purchaseOrderId: {
      type: ObjectId,
      ref: "ScreenLicensePurchaseOrder",
      index: true
    },
    orderCode: { type: String },
    installmentNumber: { type: Number },
    installmentsInTerm: { type: Number },
    // The first day of the cycle this invoice covers — when it is raised.
    billDate: { type: Date },

    invoiceNumber: {
      type: String,
      required: true,
      unique: true
    },

    billingCycle: {
      type: String,
      enum: RESELLER_BILLING_CYCLES,
      required: true
    },

    billingPeriodStart: { type: Date, required: true },
    billingPeriodEnd: { type: Date, required: true },

    // Full-rate ("base") licenses billed this cycle — licenses purchased
    // before billingPeriodStart. Excludes any mid-cycle purchases that
    // were prorated (daily_proration) or deferred entirely (none) via
    // proratedLicenseCount below — see services/resellerBilling.js B14a.
    purchasedLicenseSnapshot: { type: Number, required: true },

    // Mid-cycle purchases (created within [billingPeriodStart,
    // billingPeriodEnd)) that were charged a partial, prorated amount
    // this cycle rather than the full per-cycle rate. 0 when
    // prorationRule is "none" (those purchases are simply deferred,
    // uncharged, to the next invoice) or when nothing was purchased
    // mid-cycle.
    proratedLicenseCount: { type: Number, default: 0 },

    // The partial charge for proratedLicenseCount, already included in
    // `subtotal`/`total` below. 0 unless prorationRule is
    // "daily_proration" and a purchase fell inside this cycle.
    proratedAmount: { type: Number, default: 0 },

    standardUnitPriceSnapshot: { type: Number, required: true },
    pricingModeSnapshot: { type: String, enum: ["discount_percent", "fixed_price"], required: true },
    wholesaleDiscountPercentSnapshot: { type: Number },
    fixedUnitPriceSnapshot: { type: Number },
    unitPriceSnapshot: { type: Number, required: true },

    // 1 monthly, 3 quarterly, 12 yearly.
    cycleMultiplier: { type: Number, required: true },

    subtotal: { type: Number, required: true },
    taxRatePercent: { type: Number, required: true },
    taxAmount: { type: Number, required: true },
    total: { type: Number, required: true },

    dueDate: { type: Date, required: true },

    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "overdue"],
      default: "pending",
      index: true
    },

    razorpay: {
      orderId: { type: String, index: true, sparse: true },
      paymentId: { type: String, index: true, sparse: true }
    },

    // Defaults to "offline" — SPOTX collects payment manually (verifying a
    // transaction reference against Razorpay themselves) unless an admin
    // switches a specific invoice to "online", which lets the reseller pay
    // it themselves via Razorpay Checkout from their own panel. Mirrors
    // the online/offline split already used for the one-time prepayment
    // (see ResellerBillingConfig.prepayment) — same reasoning, now applied
    // per invoice instead of per partner.
    paymentMode: {
      type: String,
      enum: ["online", "offline"],
      default: "offline"
    },

    // A reseller on an "offline" invoice can ask SPOTX to switch it to
    // online instead of waiting to be contacted — purely a flag + the
    // admin still has to act on it (adminInvoiceController.setInvoicePaymentMode).
    onlineRequested: { type: Boolean, default: false },
    onlineRequestedAt: { type: Date },

    // Set when an admin verifies an offline payment against Razorpay —
    // the reseller's own reference for a payment made outside the app.
    offlinePayment: {
        method: { type: String, enum: ["razorpay", "cheque", "cash"], default: "razorpay" },
      transactionId: { type: String, default: "" },
      verifiedBy: { type: ObjectId, ref: "User" },
      verifiedAt: { type: Date }
    },

    paidAt: { type: Date },
    cheque: {
      number: String,
      status: { type: String, enum: ["received", "cleared", "bounced"] },
      updatedAt: Date,
      updatedBy: { type: ObjectId, ref: "User" }
    },
    paymentHistory: [{
      action: String,
      method: String,
      reference: String,
      amount: Number,
      recordedAt: { type: Date, default: Date.now },
      recordedBy: { type: ObjectId, ref: "User" }
    }]
  },
  {
    timestamps: true
  }
);

// Prevents a duplicate invoice for the same partner/period if the
// billing job (manual today, scheduled later) runs twice.
// One invoice per purchase per cycle. (The old unique index on
// partner + period is dropped at startup — see index.js — because two
// purchases made on the same day now each get their own invoice.)
ResellerInvoiceSchema.index(
  { purchaseOrderId: 1, billingPeriodStart: 1 },
  { unique: true, partialFilterExpression: { purchaseOrderId: { $exists: true } } }
);

module.exports = model("ResellerInvoice", ResellerInvoiceSchema);
