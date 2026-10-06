const mongoose = require("mongoose");
const { Schema, model } = mongoose;

/* ============================================================
   EMAIL OTP — registration email verification
   One document per email (upserted on resend). TTL-indexed on
   expiresAt so stale/used records clean themselves up.
============================================================ */

const EmailOtpSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },

    // Hashed IP of the most recent requester — see OtpRateLimit for the
    // per-network cap.
    ipHash: {
      type: String,
      index: true
    },

    otpHash: {
      type: String,
      required: true
    },

    // Per-email send throttling (see enforceOtpRequestLimit in
    // partnerAuthController).
    requestCount: {
      type: Number,
      default: 0
    },

    firstRequestAt: {
      type: Date
    },

    lastSentAt: {
      type: Date
    },

    expiresAt: {
      type: Date,
      required: true
    },

    attempts: {
      type: Number,
      default: 0
    },

    verified: {
      type: Boolean,
      default: false
    },

    // Single-use proof of verification, checked by registerPartner —
    // knowing the email was verified isn't enough on its own, since a
    // client could just claim verified: true without one.
    verificationToken: {
      type: String
    },

    verifiedAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

EmailOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model("EmailOtp", EmailOtpSchema);
