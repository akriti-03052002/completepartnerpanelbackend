const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   PARTNER AGREEMENT ACCEPTANCE
   A visible, separate record that a given Partner Agreement PDF
   (stored as a PartnerDocument, documentType "partner_agreement") was
   accepted — distinct from PartnerDocument.verification, which only
   records that SPOTX itself verified/generated the file, not that the
   Partner has agreed to its terms.

   Acceptance here is always automatic: the moment an admin assigns a
   vendor's commission terms (see PartnerCommissionAssignment) and the
   agreement reflecting them is generated, it's recorded as accepted on
   the Partner's behalf — no separate partner sign-off step exists. New
   model so PartnerDocument itself never needs an "accepted" field added.
============================================================ */

const PartnerAgreementAcceptanceSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    documentId: {
      type: ObjectId,
      ref: "PartnerDocument",
      required: true
    },

    commissionAssignmentId: {
      type: ObjectId,
      ref: "PartnerCommissionAssignment"
    },

    // Human-readable reference shown in the UI, e.g. "SPX-AGR-VND1234-v2"
    // — versioned because every commission reassignment reissues a new
    // agreement + acceptance row rather than editing the old one.
    agreementRef: {
      type: String,
      required: true
    },

    version: {
      type: Number,
      default: 1
    },

    acceptedBy: {
      type: String,
      enum: ["system_auto"],
      default: "system_auto"
    },

    acceptedAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    timestamps: true
  }
);

PartnerAgreementAcceptanceSchema.index({ partnerId: 1, createdAt: -1 });

module.exports = model("PartnerAgreementAcceptance", PartnerAgreementAcceptanceSchema);
