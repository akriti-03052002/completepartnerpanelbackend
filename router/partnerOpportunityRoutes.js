const express = require("express");
const router = express.Router();

const { listOpportunities, createOpportunity } = require("../controller/partnerOpportunityController");
const requirePermission = require("../middleware/requirePermission");

router.get("/", requirePermission("opportunities:view"), listOpportunities);
router.post("/", requirePermission("opportunities:create"), createOpportunity);

module.exports = router;
