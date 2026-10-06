const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   PARTNER USERS
============================================================ */

const PartnerUserSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    name: {
      type: String,
      required: true
    },

    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    },

    phone: {
      type: String,
      default: ""
    },

    role: {
      type: String,
      enum: ["owner", "admin", "sales", "finance", "viewer"],
      default: "viewer"
    },

    permissions: [
      {
        type: String
      }
    ],

    auth: {
      invitationClaim: { type: String, select: false },
      invitationClaimExpires: { type: Date, select: false },
      invitationPendingHash: { type: String, select: false },
      invitationPendingExpires: { type: Date, select: false },
      passwordSetupComplete: { type: Boolean, default: true },
      provider: {
        type: String,
        enum: ["email", "google", "sso"],
        default: "email"
      },

      passwordHash: {
        type: String,
        select: false
      },

      lastLoginAt: {
        type: Date
      },

      resetTokenHash: {
        type: String,
        select: false
      },

      resetTokenExpires: {
        type: Date,
        select: false
      }
    },

    status: {
      type: String,
      enum: ["active", "invited", "blocked"],
      default: "invited"
    }
  },
  {
    timestamps: true
  }
);

PartnerUserSchema.index({ email: 1 }, { unique: true });

module.exports = model("PartnerUser", PartnerUserSchema);
