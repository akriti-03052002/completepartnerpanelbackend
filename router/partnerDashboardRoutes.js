const express = require("express");
const router = express.Router();

const { getDashboard } = require("../controller/partnerDashboardController");
const requirePermission = require("../middleware/requirePermission");

router.get("/", requirePermission("dashboard:view"), getDashboard);

module.exports = router;
