const { PartnerNotification } = require("../models/Index");

/* ============================================================
   PARTNER NOTIFICATIONS
============================================================ */

const listNotifications = async (req, res) => {
  const notifications = await PartnerNotification.find({ partnerId: req.partner._id }).sort({ createdAt: -1 }).limit(100);

  return res.json({ success: true, data: notifications });
};

const markAsRead = async (req, res) => {
  const notification = await PartnerNotification.findOneAndUpdate(
    { _id: req.params.id, partnerId: req.partner._id },
    { $set: { read: true, readAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!notification) {
    return res.status(404).json({ success: false, message: "Notification not found." });
  }

  return res.json({ success: true, data: notification });
};

const markAllAsRead = async (req, res) => {
  await PartnerNotification.updateMany(
    { partnerId: req.partner._id, read: false },
    { $set: { read: true, readAt: new Date() } }
  );

  return res.json({ success: true, message: "All notifications marked as read." });
};

module.exports = { listNotifications, markAsRead, markAllAsRead };
