const express = require("express");
const router = express.Router();

const { getKpis, getDashboard, getTypeOverview } = require("../controller/adminStatsController");
const requireAdminRole = require("../middleware/requireAdminRole");

router.get("/kpis", requireAdminRole("finance", "kyc_reviewer"), getKpis);
router.get("/dashboard", requireAdminRole("finance", "kyc_reviewer"), getDashboard);
router.get("/type/:partnerType", requireAdminRole("finance", "kyc_reviewer"), getTypeOverview);

module.exports = router;
