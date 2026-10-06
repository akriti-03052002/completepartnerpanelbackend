const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const OtpRateLimitSchema = new Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    kind: {
      type: String,
      enum: ["email", "ip"],
      required: true,
      index: true
    },
    count: {
      type: Number,
      default: 0
    },
    windowStart: {
      type: Date,
      required: true,
      default: Date.now
    },
    lastRequestedAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

module.exports = model("OtpRateLimit", OtpRateLimitSchema);
