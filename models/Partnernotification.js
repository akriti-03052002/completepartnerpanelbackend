const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   NOTIFICATIONS
============================================================ */

const PartnerNotificationSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      index: true
    },

    partnerUserId: {
      type: ObjectId,
      ref: "PartnerUser"
    },

    type: {
      type: String,
      required: true
    },

    title: {
      type: String,
      default: ""
    },

    message: {
      type: String,
      default: ""
    },

    entity: {
      type: { type: String },
      entityId: { type: ObjectId }
    },

    read: {
      type: Boolean,
      default: false,
      index: true
    },

    readAt: {
      type: Date
    }
  },
  {
    timestamps: true
  }
);

module.exports = model("PartnerNotification", PartnerNotificationSchema);