const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const { COMMISSION_TYPES } = require("../config/constant");

/* ============================================================
   PARTNER COMMISSION ASSIGNMENT (Vendor only)
   A custom, per-vendor commission override that an admin sets directly
   on one vendor partner — independent of the shared Tier/CommissionRule
   ladder (CommissionRule stays untouched; this is a new, separate model
   so no existing model needs editing). Mirrors CommissionRule's payout
   fields exactly so it's a drop-in substitute anywhere a CommissionRule
   would otherwise be read (see utils/partnerCommissionResolver.js) — the
   commission engine and the agreement generator both resolve through
   the same lookup, so the terms an agreement describes can never drift
   from what's actually paid out.

   Only one row is ever "active" per partner — assigning a new one first
   supersedes whatever was active before, keeping every prior assignment
   on record instead of overwriting it (an audit trail, same spirit as
   PartnerSettlementHistory).
============================================================ */

const PartnerCommissionAssignmentSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    commissionType: {
      type: String,
      enum: COMMISSION_TYPES,
      required: true
    },

    rate: { type: Number, default: 0 },
    fixedAmount: { type: Number, default: 0 },
    perScreenAmount: { type: Number, default: 0 },

    hybrid: {
      percentageRate: { type: Number, default: 0 },
      fixedAmount: { type: Number, default: 0 },
      perScreenAmount: { type: Number, default: 0 }
    },

    calculationBase: {
      type: String,
      enum: ["invoice_total", "subscription_value", "net_revenue", "first_payment", "screen_count"],
      default: "net_revenue"
    },

    recurring: {
      enabled: { type: Boolean, default: false },
      durationType: {
        type: String,
        enum: ["months", "years", "lifetime", "none"],
        default: "none"
      },
      duration: { type: Number, default: 0 }
    },

    minimumSettlementAmount: { type: Number, default: 0 },

    notes: { type: String, default: "" },

    // "superseded" the moment a newer assignment is created for the same
    // partner — never deleted, so the full history of what a partner was
    // once promised stays queryable.
    status: {
      type: String,
      enum: ["active", "superseded"],
      default: "active"
    },

    assignedBy: {
      type: ObjectId,
      ref: "User",
      required: true
    },

    assignedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

PartnerCommissionAssignmentSchema.index({ partnerId: 1, status: 1 });

module.exports = model("PartnerCommissionAssignment", PartnerCommissionAssignmentSchema);
