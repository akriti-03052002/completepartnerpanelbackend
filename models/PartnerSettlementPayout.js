const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   PARTNER SETTLEMENT PAYOUT (RazorpayX automated payout attempt)
   Only created when an admin chooses "Pay via RazorpayX" instead of the
   offline or Razorpay-verify paths — mirrors how CustomerPayment tracks
   the customer-side Razorpay transaction. One row per payout attempt;
   status mirrors RazorpayX's own payout status vocabulary so a webhook
   (payout.processed / payout.reversed / payout.failed — see
   controller/razorpayWebhookController.js) can update it directly.
============================================================ */

const PartnerSettlementPayoutSchema = new Schema(
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

    // What's actually transferred: net-of-TDS commission + GST (if a
    // verified bill exists for this settlement) — see
    // adminSettlementController's shared computePayableAmount helper.
    amount: {
      net: { type: Number, required: true },
      gst: { type: Number, default: 0 },
      total: { type: Number, required: true },
      currency: { type: String, default: "INR" }
    },

    razorpayX: {
      payoutId: { type: String, index: true, sparse: true },
      fundAccountId: { type: String },
      mode: { type: String, default: "" },
      utr: { type: String, default: "" },
      failureReason: { type: String, default: "" }
    },

    // Mirrors RazorpayX's own payout status values (queued/pending land as
    // "initiated" here, since both just mean "not resolved yet").
    status: {
      type: String,
      enum: ["initiated", "processing", "processed", "reversed", "failed"],
      default: "initiated",
      index: true
    },

    // true only for payouts created via the explicit "Simulate" action
    // (adminSettlementController.simulateRazorpayXPayout) — no real
    // RazorpayX API call was made, no money moved. Kept permanently on the
    // row so this is never ambiguous later when looking at payout history.
    demo: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

module.exports = model("PartnerSettlementPayout", PartnerSettlementPayoutSchema);
