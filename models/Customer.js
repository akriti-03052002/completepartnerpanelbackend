const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const { SUBSCRIPTION_DURATIONS } = require("../config/constant");

/* ============================================================
   CUSTOMER
   A Vendor partner's end customer — registers either directly
   (the vendor creates the account) or self-serve using the
   vendor's referral code. Gets a 30-day trial on creation.
   Standalone for this project — link to your main SPOTX CRM's
   customer collection later if needed.
============================================================ */

const TRIAL_DURATION_DAYS = 30;

const CustomerSchema = new Schema(
  {
    companyName: {
      type: String,
      required: true,
      trim: true
    },

    contactName: {
      type: String,
      default: ""
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },

    phone: {
      type: String,
      default: ""
    },

    // Same shape as Partner.address — kept independent (not shared) since a
    // customer's install address has nothing to do with their vendor's.
    address: {
      country: { type: String, default: "India" },
      state: { type: String, default: "" },
      city: { type: String, default: "" },
      addressLine1: { type: String, default: "" },
      addressLine2: { type: String, default: "" },
      pincode: { type: String, default: "" }
    },

    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    // How this customer ended up mapped to the partner above — the vendor
    // created them directly, or they self-registered with the vendor's
    // referral code.
    registrationSource: {
      type: String,
      enum: ["partner_direct", "referral_code"],
      default: "referral_code"
    },

    auth: {
      googleSub: { type: String, unique: true, sparse: true, select: false },
      sessionVersion: { type: Number, default: 0 },
      // Missing on historical accounts; new registrations explicitly start unverified.
      emailVerified: { type: Boolean },
      passwordHash: {
        type: String,
        select: false
      },
      lastLoginAt: {
        type: Date
      },
      // Set-password / reset-password token — a partner-registered customer
      // starts with no passwordHash and gets emailed a link to set one
      // themselves (see customerPublicController.resetCustomerPassword).
      // Neither the partner nor an admin ever sets or sees the password.
      resetTokenHash: {
        type: String,
        select: false
      },
      resetTokenExpires: {
        type: Date,
        select: false
      }
    },

    trial: {
      startedAt: {
        type: Date
      },
      endsAt: {
        type: Date
      }
    },

    subscription: {
      status: {
        type: String,
        enum: ["trial", "active", "expired", "cancelled"],
        default: "trial"
      },
      screenCount: {
        type: Number,
        default: 0
      },
      // Which priced plan the customer subscribed under (see ScreenPricing) —
      // only set once they've actually subscribed (self-service, no gateway).
      plan: {
        type: String,
        enum: ["basic", "premium"]
      },
      // Prepaid term length in months, chosen at subscribe/renew time —
      // price is screenCount × plan rate × durationMonths. Defaults to 1
      // for customers who subscribed before this field existed.
      durationMonths: {
        type: Number,
        enum: SUBSCRIPTION_DURATIONS,
        default: 1
      },
      // Current billing cycle (durationMonths × 30 days). A mid-cycle
      // upgrade (or lateral change) at the SAME durationMonths prorates the
      // charge for the days left in this window rather than resetting it.
      // Picking a different durationMonths always starts a fresh term at
      // full price instead (see customerSubscriptionController.computeChange)
      // — the next change/renewal after currentPeriodEnd is charged in full.
      currentPeriodStart: { type: Date },
      currentPeriodEnd: { type: Date },
      // A downgrade requested mid-cycle (same durationMonths) doesn't take
      // effect immediately — they keep what they already paid for until
      // currentPeriodEnd, at which point this is what they switch to (see
      // materializeScheduledChangeIfDue). No charge, no refund either way.
      scheduledChange: {
        plan: { type: String, enum: ["basic", "premium"] },
        screenCount: { type: Number },
        durationMonths: { type: Number, enum: SUBSCRIPTION_DURATIONS }
      }
    },

    status: {
      type: String,
      enum: ["active", "suspended"],
      default: "active"
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// No cron/scheduler in this project (see commissionEngine's recurring-cycle
// limitation) — trial expiry is derived on read instead of flipping a
// stored status in the background.
CustomerSchema.virtual("trialExpired").get(function () {
  return this.subscription.status === "trial" && Boolean(this.trial.endsAt) && new Date() > this.trial.endsAt;
});

CustomerSchema.statics.TRIAL_DURATION_DAYS = TRIAL_DURATION_DAYS;

module.exports = model("Customer", CustomerSchema);
