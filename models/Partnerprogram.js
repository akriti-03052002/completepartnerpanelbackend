const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

const { PARTNER_TYPES } = require("../config/constant");

/* ============================================================
   PARTNER PROGRAM
   A limited-time promotional campaign SpotX runs (announced on the
   site, Instagram, etc.) — distinct from normal open-ended partner
   registration. Joining through an active program's window grants
   whatever `incentive` it's configured with (a signup bonus, a
   starting tier upgrade, or both).
============================================================ */

const PartnerProgramSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },

    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true
    },

    type: {
      type: String,
      enum: PARTNER_TYPES,
      required: true
    },

    description: {
      type: String,
      default: ""
    },

    /* MARKETING DISPLAY — shown on the public landing page when active */
    bannerHeadline: {
      type: String,
      default: ""
    },

    isPublic: {
      type: Boolean,
      default: true
    },

    /* WINDOW — outside [startDate, endDate], the program can't be joined
       even if status is "active". Either bound may be left unset. */
    startDate: {
      type: Date
    },

    endDate: {
      type: Date
    },

    /* WHAT A PARTNER GETS FOR JOINING DURING THE WINDOW */
    incentive: {
      description: { type: String, default: "" },

      // One-time bonus. Not tied to a deal, so it doesn't flow through
      // the commission engine — logged as an activity/notification and
      // settled manually by an admin.
      bonusAmount: { type: Number, default: 0 },

      // Skip straight to a better tier instead of starting at the
      // partner type's base tier.
      startingTierId: {
        type: ObjectId,
        ref: "PartnerTier"
      }
    },

    commissionEnabled: {
      type: Boolean,
      default: true
    },

    settlementEnabled: {
      type: Boolean,
      default: true
    },

    status: {
      type: String,
      enum: ["draft", "active", "inactive"],
      default: "draft"
    }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// True only when status is "active" AND today falls inside the window
// (an unset bound is treated as open-ended on that side).
PartnerProgramSchema.virtual("isActiveNow").get(function () {
  if (this.status !== "active") return false;

  const now = new Date();
  if (this.startDate && now < this.startDate) return false;
  if (this.endDate && now > this.endDate) return false;

  return true;
});

module.exports = model("PartnerProgram", PartnerProgramSchema);