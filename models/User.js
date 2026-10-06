const mongoose = require("mongoose");
const { Schema, model } = mongoose;

/* ============================================================
   INTERNAL SPOTX STAFF (Admin side)
   Fully separate from PartnerUser / partner auth.
============================================================ */

const UserSchema = new Schema(
  {
    name: {
      type: String,
      required: true
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true
    },

    passwordHash: {
      type: String,
      required: true,
      select: false
    },

    role: {
      type: String,
      enum: ["super_admin", "kyc_reviewer", "finance"],
      required: true
    },

    status: {
      type: String,
      enum: ["active", "blocked"],
      default: "active"
    },

    lastLoginAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

module.exports = model("User", UserSchema);
