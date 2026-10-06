const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const { VERIFICATION_STATUS } = require("../config/constant");

/* ============================================================
   PARTNER DOCUMENTS / KYC
   Required: MSME / Udyam, GST, PAN, Cancelled Cheque
============================================================ */

const PartnerDocumentSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    documentType: {
      type: String,
      enum: [
        // KYC
        "msme_udyam",
        "gst_certificate",
        "pan_card",

        // BANK
        "cancelled_cheque",
        "bank_proof",

        // OTHER
        "partner_agreement",
        "other"
      ],
      required: true
    },

    documentNumber: {
      type: String,
      default: ""
    },

    /* FILE */
    file: {
      storageProvider: {
        type: String,
        enum: ["cloudinary"],
        default: "cloudinary"
      },

      objectKey: {
        type: String,
        required: true
      },

      originalName: {
        type: String,
        default: ""
      },

      mimeType: {
        type: String,
        default: ""
      },

      size: {
        type: Number,
        default: 0
      },

      checksum: {
        type: String,
        default: ""
      }
    },

    /* VERIFICATION */
    verification: {
      status: {
        type: String,
        enum: VERIFICATION_STATUS,
        default: "pending"
      },

      verifiedBy: {
        type: ObjectId,
        ref: "User"
      },

      verifiedAt: {
        type: Date
      },

      rejectionReason: {
        type: String,
        default: ""
      },

      expiryDate: {
        type: Date
      }
    }
  },
  {
    timestamps: true
  }
);

PartnerDocumentSchema.index({
  partnerId: 1,
  documentType: 1,
  createdAt: -1
});

module.exports = model("PartnerDocument", PartnerDocumentSchema);