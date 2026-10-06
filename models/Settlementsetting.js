const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const { SETTLEMENT_TYPES } = require("../config/constant");

/* ============================================================
   SETTLEMENT SETTINGS
============================================================ */

const SettlementSettingSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      unique: true
    },

    /* SETTLEMENT TYPE */
    settlementType: {
      type: String,
      enum: SETTLEMENT_TYPES,
      default: "monthly"
    },

    /* MONTHLY / QUARTERLY DAY */
    settlementDay: {
      type: Number,
      min: 1,
      max: 31
    },

    /* THRESHOLD — Example: Don't settle until commission reaches ₹5,000 */
    minimumSettlementAmount: {
      type: Number,
      default: 0
    },

    currency: {
      type: String,
      default: "INR"
    },

    /* PAYMENT METHOD */
    paymentMethod: {
      type: String,
      enum: ["bank_transfer", "upi", "other"],
      default: "bank_transfer"
    },

    /* TAX */
    tax: {
      tdsEnabled: { type: Boolean, default: false },
      tdsRate: { type: Number, default: 0 }
    },

    /* AUTO SETTLEMENT */
    autoSettlement: {
      type: Boolean,
      default: false
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

module.exports = model("SettlementSetting", SettlementSettingSchema);