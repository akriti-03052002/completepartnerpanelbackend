const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   LICENSE TRANSACTION
   Append-only ledger of every ResellerInventory change — the
   source of truth for a Reseller's inventory history table. Every
   write here happens inside the same DB transaction as the
   ResellerInventory update that caused it (see
   services/resellerInventory.js). Never edited or deleted.
============================================================ */

const LicenseTransactionSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    customerId: {
      type: ObjectId,
      ref: "ResellerCustomer"
    },

    allocationId: {
      type: ObjectId,
      ref: "CustomerAllocation"
    },

    purchaseOrderId: {
      type: ObjectId,
      ref: "ScreenLicensePurchaseOrder"
    },

    type: {
      type: String,
      enum: [
        "purchase",
        "allocation",
        "release",
        "adjustment",
        "registration",
        "activation",
        "suspension",
        "reactivation",
        "cancellation"
      ],
      required: true
    },

    // Signed — +500 for a purchase, -100 for an allocation, etc.
    quantity: {
      type: Number,
      required: true
    },

    previousBalance: { type: Number, required: true },
    newBalance: { type: Number, required: true },

    reason: {
      type: String,
      default: ""
    },

    createdBy: {
      type: ObjectId
    }
  },
  {
    timestamps: true
  }
);

LicenseTransactionSchema.index({ partnerId: 1, createdAt: -1 });

module.exports = model("LicenseTransaction", LicenseTransactionSchema);
