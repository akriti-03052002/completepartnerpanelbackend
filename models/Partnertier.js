const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const { PARTNER_TYPES } = require("../config/constant");

/* ============================================================
   PARTNER TIERS
   Every partner type climbs its own Registered -> Certified ->
   Gold -> Strategic ladder, but each type qualifies on a different
   metric (screens for Vendor, leads for Affiliate, reach for
   Influencer, intros for Referral, volume for Reseller) and pays
   out differently (see CommissionRule.commissionType).
============================================================ */

const PartnerTierSchema = new Schema(
  {
    // Which partner type this tier ladder belongs to. Not required at
    // the schema level so the original 4 vendor tiers (created before
    // this field existed) keep loading — new tiers should always set it.
    partnerType: {
      type: String,
      enum: PARTNER_TYPES
    },

    programId: {
      type: ObjectId,
      ref: "PartnerProgram",
      index: true
    },

    name: {
      type: String,
      required: true
      // Example: Registered, Certified, Gold, Strategic
    },

    code: {
      type: String,
      required: true,
      uppercase: true
    },

    level: {
      type: Number,
      required: true
    },

    qualification: {
      // Vendor-specific (kept for backward compatibility with the
      // original 4 vendor tiers). New tiers of any type should use
      // `metric` below instead, which names its own unit.
      screenCount: {
        min: { type: Number, default: 0 },
        max: { type: Number, default: null }
      },

      revenue: {
        min: { type: Number, default: 0 },
        max: { type: Number, default: null },
        currency: { type: String, default: "INR" }
      },

      dealCount: {
        min: { type: Number, default: 0 },
        max: { type: Number, default: null }
      },

      // Generic threshold for non-vendor types, e.g. { label: "leads
      // referred", min: 50, max: 199 } for an Affiliate tier, or
      // { label: "volume purchased", min: ... } for a Reseller tier.
      metric: {
        label: { type: String, default: "" },
        min: { type: Number, default: 0 },
        max: { type: Number, default: null }
      }
    },

    benefits: {
      commissionRate: { type: Number, default: 0 },
      prioritySupport: { type: Boolean, default: false },
      dedicatedManager: { type: Boolean, default: false },
      coMarketing: { type: Boolean, default: false },
      earlyProductAccess: { type: Boolean, default: false },

      // Free-text perks (e.g. "Sales kit", "Demo account", "White-label",
      // "Territory rights") — the fixed booleans above don't cover every
      // real-world benefit, so this is the source of truth for display.
      perks: [{ type: String }]
    },

    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active"
    }
  },
  {
    timestamps: true
  }
);

// Unique per (programId, code) — programId is usually unset, so give
// non-vendor tiers a type-prefixed code (e.g. "AFFILIATE-GOLD") to avoid
// colliding with vendor's existing unprefixed codes ("GOLD", etc.).
PartnerTierSchema.index({ programId: 1, code: 1 }, { unique: true });

module.exports = model("PartnerTier", PartnerTierSchema);