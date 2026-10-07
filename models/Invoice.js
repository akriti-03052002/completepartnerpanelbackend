const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   INVOICE
   A Vendor customer's record of a subscription payment — what their
   Billing page lists. One is issued (already "paid") each time a
   payment is confirmed: by Razorpay for a self-service checkout (see
   services/customerPaymentFulfillment.js) or by an admin recording a
   payment received outside the gateway (adminCustomerController).
   Also referenced by PartnerCommission.transaction.invoiceId.
============================================================ */

const InvoiceSchema = new Schema(
  {
    customerId: {
      type: ObjectId,
      ref: "Customer",
      index: true
    },

    partnerId: {
      type: ObjectId,
      ref: "Partner",
      index: true
    },

    amount: {
      type: Number,
      default: 0
    },

    currency: {
      type: String,
      default: "INR"
    },

    status: {
      type: String,
      enum: ["draft", "issued", "paid", "void"],
      default: "draft"
    },

    issuedAt: {
      type: Date
    },

    // The online payment this invoice is for, when there is one — unique,
    // so the browser confirmation and the webhook can't both issue it.
    customerPaymentId: {
      type: ObjectId,
      ref: "CustomerPayment"
    },
    manualPaymentReference: { type: String }
  },
  {
    timestamps: true
  }
);

InvoiceSchema.index({ customerPaymentId: 1 }, { unique: true, sparse: true });
InvoiceSchema.index({ manualPaymentReference: 1 }, { unique: true, sparse: true });

module.exports = model("Invoice", InvoiceSchema);
