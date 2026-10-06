const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   CUSTOMER ALLOCATION
   The license-level relationship between a Reseller partner and
   one of its ResellerCustomers. Deliberately has NO price/resale
   field of any kind — what the Reseller charges its own customer
   for the bundle is out of scope for this platform entirely, not
   tracked, not stored, not shown anywhere. activatedAt IS the customer's subscription start date —
   there is no separate trial period/field.
============================================================ */

const CustomerAllocationSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    customerId: {
      type: ObjectId,
      ref: "ResellerCustomer",
      required: true,
      index: true
    },

    allocatedLicenses: { type: Number, default: 0, min: 0 },
    registeredScreens: { type: Number, default: 0, min: 0 },
    activeScreens: { type: Number, default: 0, min: 0 },
    suspendedScreens: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: ["allocated", "pending_activation", "active", "suspended", "cancelled"],
      default: "allocated"
    },

    allocatedAt: { type: Date, default: Date.now },
    activatedAt: { type: Date },
    releasedAt: { type: Date }
  },
  {
    timestamps: true
  }
);

CustomerAllocationSchema.index({ partnerId: 1, customerId: 1 });

module.exports = model("CustomerAllocation", CustomerAllocationSchema);
