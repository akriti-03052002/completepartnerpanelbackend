const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const { RESELLER_BILLING_CYCLES } = require("../config/constant");

/* ============================================================
   RESELLER BILLING CONFIG
   One record per Reseller partner — how and when SPOTX bills them,
   set by superadmin from their signed agreement. billingMetric is
   fixed to "purchased" — SPOTX always bills on total purchased
   licenses, never on active/allocated/registered usage. billingCycle is
   explicitly NOT compulsorily monthly.

   Defaults below follow standard recurring-billing/dunning
   practice:
     Net 7 due date, a reminder 3 days before due, retries at
     day 1/3/5 past due, then 3 grace days before restriction —
     8 days total from due date to restriction. Configurable per
     partner, not hard-coded as a system-wide rule.
============================================================ */

const ResellerBillingConfigSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      unique: true,
      index: true
    },

    // Fixed — never anything else. Kept as an explicit field (rather than
    // just an implicit constant) so every downstream billing read makes
    // the invariant visible rather than assumed.
    billingMetric: {
      type: String,
      enum: ["purchased"],
      default: "purchased",
      required: true
    },

    billingCycle: {
      type: String,
      enum: RESELLER_BILLING_CYCLES,
      required: true,
      default: "monthly"
    },

    billingStartRule: {
      type: String,
      enum: ["on_first_purchase", "fixed_day_of_month"],
      default: "on_first_purchase"
    },

    // Retained for compatibility with existing billing configuration. Paid
    // licenses purchased during a cycle are always added to that cycle's
    // invoice at their locked purchase price; they are never silently
    // deferred to a later cycle.
    prorationRule: {
      type: String,
      enum: ["none", "daily_proration"],
      default: "daily_proration"
    },

    dueDays: { type: Number, default: 7 },

    dueDateReminderDaysBefore: { type: Number, default: 3 },

    lowInventoryNotificationThresholdPercent: { type: Number, default: 10 },

    retrySchedule: [
      {
        dayOffset: { type: Number, required: true }
      }
    ],

    gracePeriodDays: { type: Number, default: 3 },

    // Triggers an admin-facing alert (RESELLER_AGREEMENT_EXPIRING audit
    // entry) as this date approaches — does not itself suspend or change
    // the partner. A SPOTX admin contacts the Reseller and applies the
    // outcome (renew/upgrade/suspend) manually via existing partner-
    // status controls.
    agreementEndDate: {
      type: Date
    },

    // A one-time setup payment required before this Reseller can submit
    // ANY license purchase request at all (see
    // partnerLicenseOrderController.createLicenseOrder's gate). Admin-
    // driven, not partner-requested — an admin decides the amount and how
    // it's paid, mirroring the online/offline split used for regular
    // license orders (see adminLicenseOrderController.js): online means
    // the reseller pays it themselves via Razorpay from their own panel;
    // offline means the admin already has a transaction reference and
    // verifies it against Razorpay directly, marking it done in one step.
    // Never resets once "done" — this is strictly one-time per partner.
    prepayment: {
      status: {
        type: String,
        enum: ["not_done", "awaiting_payment", "done"],
        default: "not_done"
      },
      paymentMode: { type: String, enum: ["online", "offline"] },
      amount: { type: Number },
      currency: { type: String, default: "INR" },
      razorpay: {
        orderId: { type: String },
        paymentId: { type: String },
        method: { type: String, default: "" }
      },
      cheque: {
        number: String,
        status: { type: String, enum: ["received", "cleared", "bounced"] },
        updatedAt: Date,
        updatedBy: { type: ObjectId, ref: "User" }
      },
      paymentHistory: [{ action: String, method: String, reference: String, amount: Number, recordedAt: Date, recordedBy: { type: ObjectId, ref: "User" } }],
      offlinePayment: {
        method: { type: String, enum: ["razorpay", "cheque", "cash"], default: "razorpay" },
        transactionId: { type: String, default: "" }
      },
      setBy: { type: ObjectId, ref: "User" },
      setAt: { type: Date },
      paidAt: { type: Date }
    }
  },
  {
    timestamps: true
  }
);

ResellerBillingConfigSchema.path("retrySchedule").default(() => [
  { dayOffset: 1 },
  { dayOffset: 3 },
  { dayOffset: 5 }
]);

module.exports = model("ResellerBillingConfig", ResellerBillingConfigSchema);
