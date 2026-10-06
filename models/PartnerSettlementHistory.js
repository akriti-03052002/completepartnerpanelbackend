const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   PARTNER SETTLEMENT HISTORY
   Append-only audit trail — one row per event on a PartnerSettlement
   (created, approved, held, released, paid, failed, retried, bill
   submitted/verified/rejected). New model so PartnerSettlement itself
   never needs a "history" array or any other edit; this just references
   it by settlementId, same pattern as PartnerSettlementBill.

   Kept separate from PartnerActivity (which is partner-facing, general-
   purpose, and has a fixed activityType enum that doesn't cover every
   settlement-specific event) so the settlement timeline can show its own
   precise action names and structured before/after snapshots without
   fighting that enum.
============================================================ */

const PartnerSettlementHistorySchema = new Schema(
  {
    settlementId: {
      type: ObjectId,
      ref: "PartnerSettlement",
      required: true,
      index: true
    },

    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    action: {
      type: String,
      enum: [
        "created",
        // A commission joined / left an open batch (settlements are built
        // automatically as commissions are approved — see services/autoSettlement.js).
        "commission_added",
        "commission_removed",
        "approved",
        "held",
        "released",
        "paid_offline",
        "cheque_received",
        "cheque_bounced",
        "paid_razorpay",
        "failed",
        "retried",
        "bill_submitted",
        "bill_verified",
        "bill_rejected"
      ],
      required: true
    },

    fromStatus: { type: String, default: "" },
    toStatus: { type: String, default: "" },

    reason: { type: String, default: "" },

    // Snapshot of what was actually payable at the time of this event, so
    // the timeline still reads correctly even if amount/tax fields on the
    // settlement itself are recalculated later.
    amount: {
      net: Number,
      gst: Number,
      total: Number,
      currency: { type: String, default: "INR" }
    },

    meta: { type: Schema.Types.Mixed, default: {} },

    performedByType: {
      type: String,
      enum: ["spotx_user", "partner_user", "system"],
      required: true
    },
    performedByUserId: { type: ObjectId },

    ipAddress: { type: String, default: "" }
  },
  {
    timestamps: true
  }
);

module.exports = model("PartnerSettlementHistory", PartnerSettlementHistorySchema);
