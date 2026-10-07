const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const InfluencerContentSubmissionSchema = new Schema(
  {
    partnerId: {
      type: Schema.Types.ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },
    socialAccountId: {
      type: Schema.Types.ObjectId,
      required: true
    },
    platform: {
      type: String,
      enum: ["instagram", "youtube", "facebook"],
      required: true
    },
    contentType: {
      type: String,
      enum: ["post", "reel"],
      required: true
    },
    url: {
      type: String,
      required: true,
      trim: true
    },
    normalizedUrl: {
      type: String,
      required: true,
      unique: true
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true
    },
    payment: {
      amount: { type: Number, min: 0, default: 0 },
      currency: { type: String, default: "INR" },
      status: { type: String, enum: ["not_assigned", "approved"], default: "not_assigned" },
      // The ledger row that carries this payment into settlements.
      commissionId: { type: Schema.Types.ObjectId, ref: "PartnerCommission" }
    },
    ownershipConfirmed: { type: Boolean, default: false },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    reviewNote: { type: String, default: "" }
  },
  { timestamps: true }
);

InfluencerContentSubmissionSchema.index({ partnerId: 1, createdAt: -1 });

InfluencerContentSubmissionSchema.index({ status: 1, createdAt: -1, _id: -1 });
module.exports = model("InfluencerContentSubmission", InfluencerContentSubmissionSchema);
