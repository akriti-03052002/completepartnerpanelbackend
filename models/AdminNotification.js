const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   ADMIN NOTIFICATION
   Something a partner of any type did that an admin should look at
   (new sign-up, KYC upload, bank details, lead, social account,
   post/reel, invoice). Each notification names the admin roles that can
   act on it (super_admin always sees everything); each admin's read
   state is kept in readBy so one admin reading it doesn't clear it for
   the others.
============================================================ */

const AdminNotificationSchema = new Schema(
  {
    type: { type: String, required: true },
    title: { type: String, required: true },
    message: { type: String, default: "" },
    // Admin panel path to open, e.g. "/admin/partners/<id>".
    link: { type: String, default: "" },
    // Empty = every admin role.
    audienceRoles: {
      type: [{ type: String, enum: ["super_admin", "kyc_reviewer", "finance"] }],
      default: []
    },
    partnerId: { type: ObjectId, ref: "Partner", index: true },
    entityType: { type: String, default: "" },
    // The record it's about (e.g. the submitted post), when there is one.
    entityId: { type: ObjectId, index: true },
    readBy: [{ type: ObjectId, ref: "User" }]
  },
  { timestamps: true }
);

AdminNotificationSchema.index({ createdAt: -1 });

module.exports = model("AdminNotification", AdminNotificationSchema);
