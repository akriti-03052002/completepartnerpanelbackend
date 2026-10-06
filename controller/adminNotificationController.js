const mongoose = require("mongoose");
const AdminNotification = require("../models/AdminNotification");
const { Partner, InfluencerContentSubmission } = require("../models/Index");

/* ============================================================
   ADMIN — NOTIFICATIONS ("what's new" bell)
============================================================ */

// super_admin sees every notification; other roles see the ones addressed
// to their role plus any addressed to everyone (including notifications
// created before audienceRoles existed).
const visibleTo = (adminUser) =>
  adminUser.role === "super_admin"
    ? {}
    : { $or: [{ audienceRoles: adminUser.role }, { audienceRoles: { $size: 0 } }, { audienceRoles: { $exists: false } }] };

const listNotifications = async (req, res) => {
  const adminId = req.adminUser._id;
  const filter = visibleTo(req.adminUser);
  const [notifications, unreadCount, pendingPosts, pendingAccounts] = await Promise.all([
    AdminNotification.find(filter).sort({ createdAt: -1 }).limit(100).lean(),
    AdminNotification.countDocuments({ ...filter, readBy: { $ne: adminId } }),
    // Live counts of what's still waiting, independent of read state — a
    // read notification doesn't mean the post was reviewed.
    InfluencerContentSubmission.countDocuments({ status: "pending" }),
    Partner.aggregate([
      { $match: { partnerType: "influencer" } },
      { $unwind: "$socialAccounts" },
      { $match: { "socialAccounts.reviewStatus": "pending" } },
      { $count: "n" }
    ]).then((rows) => rows[0]?.n || 0)
  ]);

  return res.json({
    success: true,
    data: {
      unreadCount,
      pending: { posts: pendingPosts, accounts: pendingAccounts },
      notifications: notifications.map(({ readBy, ...n }) => ({
        ...n,
        read: (readBy || []).some((id) => String(id) === String(adminId))
      }))
    }
  });
};

const markRead = async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ success: false, message: "Invalid notification." });
  }
  await AdminNotification.updateOne({ _id: req.params.id, ...visibleTo(req.adminUser) }, { $addToSet: { readBy: req.adminUser._id } });
  return res.json({ success: true });
};

const markAllRead = async (req, res) => {
  await AdminNotification.updateMany({ ...visibleTo(req.adminUser), readBy: { $ne: req.adminUser._id } }, { $addToSet: { readBy: req.adminUser._id } });
  return res.json({ success: true });
};

module.exports = { listNotifications, markRead, markAllRead };
