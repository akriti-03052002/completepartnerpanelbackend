const express = require("express");
const router = express.Router();

const { listNotifications, markAsRead, markAllAsRead } = require("../controller/partnerNotificationController");
const requirePermission = require("../middleware/requirePermission");

router.get("/", requirePermission("notifications:view"), listNotifications);
router.patch("/:id/read", requirePermission("notifications:view"), markAsRead);
router.patch("/read-all", requirePermission("notifications:view"), markAllAsRead);

module.exports = router;
