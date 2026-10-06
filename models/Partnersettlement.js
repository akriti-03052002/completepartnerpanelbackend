const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const { SETTLEMENT_TYPES } = require("../config/constant");

/* ============================================================
   PARTNER SETTLEMENT / PAYOUT
============================================================ */

const PartnerSettlementSchema = new Schema(
  {
    settlementNumber: {
      type: String,
      unique: true,
      index: true
    },

    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    /* COMMISSIONS INCLUDED */
    commissionIds: [
      {
        type: ObjectId,
        ref: "PartnerCommission"
      }
    ],

    /* SETTLEMENT PERIOD */
    period: {
      from: Date,
      to: Date
    },

    settlementType: {
      type: String,
      enum: SETTLEMENT_TYPES,
      required: true
    },

    /* MONEY */
    amount: {
      gross: { type: Number, default: 0 },
      deductions: { type: Number, default: 0 },
      net: { type: Number, default: 0 },
      currency: { type: String, default: "INR" }
    },

    /* TAX */
    tax: {
      tdsRate: { type: Number, default: 0 },
      tdsAmount: { type: Number, default: 0 }
    },

      cheque: {
        number: String,
        status: { type: String, enum: ["received", "cleared", "bounced"] },
        updatedAt: Date,
        updatedBy: { type: ObjectId, ref: "User" }
      },

    /* PAYMENT */
    payment: {
      method: {
        type: String,
        // bank_transfer / upi / other are what an admin picks for an offline
        // payment; the rest are methods Razorpay reports on a verified
        // online payment.
        enum: ["bank_transfer", "upi", "cheque", "cash", "other", "card", "netbanking", "wallet", "emi", "paylater"]
      },
      transactionId: { type: String, default: "" },
      paidAt: Date
    },

    /* SETTLEMENT STATUS */
    status: {
      type: String,
      enum: [
        "draft",
        "pending_approval",
        "approved",
        "processing",
        "on_hold",
        "paid",
        "failed",
        "cancelled"
      ],
      default: "draft",
      index: true
    },

    // if approvedBy is empty, treat as system-approved
    approvedBy: {
      type: ObjectId,
      ref: "User"
    },

    approvedAt: Date,

    failureReason: {
      type: String,
      default: ""
    },

    /* HOLD — settlement.status === "on_hold" points here for why, and
       previousStatus is what release should restore instead of guessing. */
    hold: {
      code: {
        type: String,
        enum: [
          "bank_unverified",
          "bank_change_pending",
          "partner_suspended",
          "compliance_review",
          "incomplete_info",
          "manual"
        ]
      },
      reason: { type: String, default: "" },
      previousStatus: { type: String },
      heldBy: { type: ObjectId, ref: "User" },
      heldAt: Date,
      releasedBy: { type: ObjectId, ref: "User" },
      releasedAt: Date
    }
  },
  {
    timestamps: true
  }
);

module.exports = model("PartnerSettlement", PartnerSettlementSchema);