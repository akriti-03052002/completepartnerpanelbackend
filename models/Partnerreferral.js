const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   PARTNER REFERRALS / LEADS
============================================================ */

const PartnerReferralSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    referralCode: {
      type: String,
      default: ""
    },

    /* CUSTOMER */
    customer: {
      companyName: { type: String, required: true },
      contactName: { type: String, default: "" },
      email: { type: String, default: "" },
      phone: { type: String, default: "" },
      city: { type: String, default: "" },
      state: { type: String, default: "" },
      country: { type: String, default: "India" }
    },

    /* REQUIREMENT */
    requirement: {
      screenCount: { type: Number, default: 0 },
      businessType: { type: String, default: "" },
      estimatedValue: { type: Number, default: 0 },
      notes: { type: String, default: "" }
    },

    /* SOURCE */
    source: {
      type: String,
      enum: ["partner_portal", "referral_link", "manual", "campaign", "api"],
      default: "partner_portal"
    },

    tracking: {
      utmSource: String,
      utmMedium: String,
      utmCampaign: String,
      landingPage: String
    },

    /* LEAD STATUS */
    status: {
      type: String,
      enum: [
        "new",
        "contacted",
        "qualified",
        "demo_scheduled",
        "demo_completed",
        "proposal",
        "won",
        "lost",
        "rejected"
      ],
      default: "new",
      index: true
    },

    closure: {
      plan: { type: String, enum: ["basic", "premium"] },
      pricePerScreen: { type: Number, default: 0 },
      dealValue: { type: Number, default: 0 },
      screenCount: { type: Number, default: 0 },
      commissionAmount: { type: Number, default: 0 },
      commissionId: { type: ObjectId, ref: "PartnerCommission" },
      reason: { type: String, default: "" },
      closedAt: Date,
      closedBy: { type: ObjectId, ref: "User" }
    },

    assignedTo: {
      salesUserId: { type: ObjectId, ref: "User" }
    },

    /* LINK TO EXISTING SPOTX CRM */
    customerId: {
      type: ObjectId,
      ref: "Customer"
    }
  },
  {
    timestamps: true
  }
);

PartnerReferralSchema.index({ partnerId: 1, createdAt: -1 });

module.exports = model("PartnerReferral", PartnerReferralSchema);