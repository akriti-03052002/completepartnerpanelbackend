const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   RESELLER CUSTOMER
   A Reseller partner's own end customer — pays the Reseller
   directly for a bundled screen+software product, never SPOTX.
   Deliberately separate from Customer.js (the Vendor's direct
   SPOTX-billed customer): different money flow, and no trial
   state exists here at all. A ResellerCustomer's subscription (to
   the Reseller, on the Reseller's own terms) begins the moment
   their screen is activated — see CustomerAllocation.activatedAt.
============================================================ */

const ResellerCustomerSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    // No GSTIN here — this customer buys the bundled screen+software
    // product from the Reseller, not from SPOTX, so SPOTX never invoices
    // them and has no reason to hold their business registration details.
    businessDetails: {
      companyName: { type: String, required: true, trim: true }
    },

    contactDetails: {
      name: { type: String, default: "" },
      email: { type: String, default: "", lowercase: true, trim: true, index: { unique: true, sparse: true } },
      phone: { type: String, default: "" }
    },

    // No "trial" value in this enum — see file header.
    status: {
      type: String,
      enum: ["pending", "allocated", "pending_activation", "active", "suspended", "cancelled"],
      default: "pending"
    },

    // Minimal customer-portal login — set once they verify their email
    // and choose a password via the link sent on registration (see
    // publicResellerCustomerController.js). Read-only portal: they can
    // view their own screens/status, nothing else. Never select()'d by
    // default — mirrors PartnerUser's auth subdocument.
    auth: {
      passwordHash: { type: String, select: false },
      emailVerified: { type: Boolean, default: false },
      verifyTokenHash: { type: String, select: false },
      verifyTokenExpires: { type: Date, select: false },
      lastLoginAt: { type: Date }
    }
  },
  {
    timestamps: true
  }
);

ResellerCustomerSchema.index({ partnerId: 1, createdAt: -1 });

module.exports = model("ResellerCustomer", ResellerCustomerSchema);
