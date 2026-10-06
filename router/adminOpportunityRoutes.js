const express = require("express");
const router = express.Router();

const { listOpportunities, updateStage, markWon, markLost } = require("../controller/adminOpportunityController");
const requireAdminRole = require("../middleware/requireAdminRole");

router.get("/", requireAdminRole("kyc_reviewer", "finance"), listOpportunities);
router.patch("/:id/stage", requireAdminRole("kyc_reviewer"), updateStage);
router.patch("/:id/win", requireAdminRole("kyc_reviewer"), markWon);
router.patch("/:id/lose", requireAdminRole("kyc_reviewer"), markLost);

module.exports = router;
