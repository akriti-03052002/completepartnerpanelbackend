const express = require("express");
const router = express.Router();

const { listNotifications, markRead, markAllRead } = require("../controller/adminNotificationController");

router.get("/", listNotifications);
router.patch("/read-all", markAllRead);
router.patch("/:id/read", markRead);

module.exports = router;
