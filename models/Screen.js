const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   SCREEN
   A physical screen a customer has registered. The customer's
   registered screen count (shown as the default on the
   Subscription page) is just a count of these per customerId.
============================================================ */

const ScreenSchema = new Schema(
  {
    customerId: {
      type: ObjectId,
      ref: "Customer",
      required: true,
      index: true
    },

    name: {
      type: String,
      required: true,
      trim: true
    },

    location: {
      type: String,
      default: ""
    },

    /* ============================================================
       RESELLER FIELDS
       Populated only for a screen registered against a Reseller's
       CustomerAllocation (see backend/models/CustomerAllocation.js).
       Left entirely unset for every other partner type's screens —
       no impact on Vendor's existing usage of this model.
    ============================================================ */
    allocationId: {
      type: ObjectId,
      ref: "CustomerAllocation",
      index: true
    },

    licenseStatus: {
      type: String,
      enum: ["allocated", "registered", "active", "suspended", "cancelled"]
    },

    // True only for a screen the Reseller sourced and sold to the
    // customer as part of a bundled screen+software sale. Purely a
    // reference flag — no hardware cost, serial number, make/model, or
    // warranty data is ever tracked here or anywhere else in this
    // system; that side of the business belongs entirely to the
    // Reseller.
    soldAsResellerBundle: {
      type: Boolean,
      default: false
    },

    registeredAt: { type: Date },
    activatedAt: { type: Date },
    suspendedAt: { type: Date },
    cancelledAt: { type: Date }
  },
  {
    timestamps: true
  }
);

module.exports = model("Screen", ScreenSchema);
