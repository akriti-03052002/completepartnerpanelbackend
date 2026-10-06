const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;
const { RESELLER_PRICING_MODES } = require("../config/constant");

/* ============================================================
   RESELLER PRICING PLAN
   One record per Reseller partner (not a single global plan) —
   the rate SPOTX charges that specific partner for software
   licenses, set by superadmin from their signed agreement. Two
   modes, exactly one active per partner at a time:
     - discount_percent: a % off the SPOTX standard list price
     - fixed_price: a flat negotiated rate, independent of the
       standard price entirely
   A partner can never change their own pricingMode/rate — this is
   superadmin-only (adminResellerConfigController.js). Snapshotted
   onto every ScreenLicensePurchaseOrder and ResellerInvoice at
   creation time, so a later rate/mode change here only affects
   future transactions.
============================================================ */

const ResellerPricingPlanSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      unique: true,
      index: true
    },

    standardPricePerScreen: {
      type: Number,
      required: true,
      default: 100
    },

    pricingMode: {
      type: String,
      enum: RESELLER_PRICING_MODES,
      required: true,
      default: "discount_percent"
    },

    // Populated only when pricingMode = "discount_percent".
    wholesaleDiscountPercent: {
      type: Number,
      min: 0,
      max: 100
    },

    // Populated only when pricingMode = "fixed_price" — independent of
    // standardPricePerScreen, could be above or below it.
    fixedPricePerScreen: {
      type: Number,
      min: 0
    },

    // Persisted (not virtual) so every snapshot downstream is explicit
    // about the number actually used, without re-deriving it.
    effectivePricePerScreen: {
      type: Number,
      required: true
    },

    minPurchaseQty: {
      type: Number,
      default: 1
    },

    // Only meaningful in discount_percent mode — a flat negotiated rate
    // is already the final number, bulk tiers don't apply.
    bulkTiers: [
      {
        minQty: { type: Number, required: true },
        pricePerScreen: { type: Number, required: true }
      }
    ],

    // Whether bulkTiers key off a single order's quantity or the
    // partner's running purchased-to-date total. Default per_order —
    // simpler to reason about, no retroactive rate changes as a
    // cumulative total crosses a threshold.
    bulkTierBasis: {
      type: String,
      enum: ["per_order", "cumulative"],
      default: "per_order"
    },

    taxRatePercent: {
      type: Number,
      default: 18
    },

    effectiveFrom: {
      type: Date,
      default: Date.now
    },

    isActive: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

// Keeps effectivePricePerScreen honest with pricingMode/rate whenever an
// admin edits this document directly (controller also recomputes this
// explicitly, but this guards any other write path too).
// Mongoose 9 removed callback-style ("next") document middleware — a plain
// synchronous function is all that's needed here.
// Runs before VALIDATION, not just before save: effectivePricePerScreen is
// required, and validation happens first — on "save" alone, a brand-new
// plan (an admin setting a Reseller's pricing for the first time) was
// rejected as missing the very field this fills in.
ResellerPricingPlanSchema.pre("validate", function () {
  if (this.pricingMode === "fixed_price") {
    this.effectivePricePerScreen = this.fixedPricePerScreen || 0;
  } else {
    const discount = this.wholesaleDiscountPercent || 0;
    this.effectivePricePerScreen = this.standardPricePerScreen * (1 - discount / 100);
  }
});

module.exports = model("ResellerPricingPlan", ResellerPricingPlanSchema);
