const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   RESELLER INVENTORY
   One document per Reseller partner — the live snapshot of their
   license ledger. SPOTX bills a Reseller on totalPurchasedLicenses
   ALONE (see services/resellerBilling.js) — none of the other
   counters here ever feed a billing calculation, they exist purely
   for the partner's own operational tracking.

   Only services/resellerInventory.js may write to this document —
   every mutation goes through an atomic, invariant-guarded update
   paired with a LicenseTransaction ledger row in the same
   transaction. No controller writes here directly.
============================================================ */

const ResellerInventorySchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      unique: true,
      index: true
    },

    totalPurchasedLicenses: { type: Number, default: 0, min: 0 },
    totalAllocatedLicenses: { type: Number, default: 0, min: 0 },
    totalRegisteredScreens: { type: Number, default: 0, min: 0 },
    totalActiveScreens: { type: Number, default: 0, min: 0 },
    totalSuspendedScreens: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["active", "restricted", "suspended"],
      default: "active"
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Computed, never stored — avoids the available count ever drifting out
// of sync with purchased/allocated.
ResellerInventorySchema.virtual("totalAvailableLicenses").get(function () {
  return Math.max(0, this.totalPurchasedLicenses - this.totalAllocatedLicenses);
});

module.exports = model("ResellerInventory", ResellerInventorySchema);
