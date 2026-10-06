const express = require("express");
const router = express.Router();

const { listCommissions } = require("../controller/partnerCommissionController");
const requirePermission = require("../middleware/requirePermission");

router.get("/", requirePermission("commissions:view"), listCommissions);

module.exports = router;
