const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   PARTNER SETTLEMENT BILL
   A GST-registered partner (has a verified "gst_certificate"
   PartnerDocument — see utils/partnerVerification.js) has to submit a
   bill/invoice for each settlement batch before it can be paid, since
   what SPotX owes them is commission + GST, not just the raw commission
   PartnerSettlement.amount already tracks. One bill per PartnerSettlement.
   Everything about whether a bill is REQUIRED and whether payout is
   BLOCKED without one lives in utils/settlementHold.js
   (checkBillRequirement) — this model is just the record itself.
============================================================ */

const PartnerSettlementBillSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    settlementId: {
      type: ObjectId,
      ref: "PartnerSettlement",
      required: true
    },

    billNumber: {
      type: String,
      required: true,
      trim: true
    },

    billDate: {
      type: Date,
      required: true
    },

    // Partner's GST registration number for this bill — no structured
    // GSTIN field exists anywhere else in the schema today (PartnerDocument
    // only has a generic free-text documentNumber), so this is where it's
    // actually captured.
    gstin: {
      type: String,
      required: true,
      trim: true,
      uppercase: true
    },

    // commission mirrors PartnerSettlement.amount.gross at submission time
    // (snapshotted, not live-computed, so the bill stays self-consistent
    // even if commission rows were somehow adjusted later). gstAmount is
    // computed server-side off the shared GST_RATE_PERCENT constant, never
    // taken from the partner's own input.
    amount: {
      commission: { type: Number, required: true },
      gstRatePercent: { type: Number, required: true },
      gstAmount: { type: Number, required: true },
      totalBillAmount: { type: Number, required: true },
      currency: { type: String, default: "INR" }
    },

    // Same file shape as PartnerDocument.file, same storage convention
    // (backend/uploads/partners/<partnerId>/bills/<file>).
    file: {
      storageProvider: { type: String, enum: ["cloudinary"], default: "cloudinary" },
      objectKey: { type: String, required: true },
      originalName: { type: String, default: "" },
      mimeType: { type: String, default: "" },
      size: { type: Number, default: 0 }
    },

    status: {
      type: String,
      enum: ["submitted", "verified", "rejected"],
      default: "submitted",
      index: true
    },

    verifiedBy: { type: ObjectId, ref: "User" },
    verifiedAt: { type: Date },
    rejectionReason: { type: String, default: "" }
  },
  {
    timestamps: true
  }
);

// One bill per settlement — resubmitting after a rejection replaces the
// prior attempt rather than piling up duplicates for the same batch.
PartnerSettlementBillSchema.index({ settlementId: 1 }, { unique: true });

module.exports = model("PartnerSettlementBill", PartnerSettlementBillSchema);
