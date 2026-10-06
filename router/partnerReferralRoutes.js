const express = require("express");
const router = express.Router();

const { listReferrals, createReferral, convertReferral } = require("../controller/partnerReferralController");
const requirePermission = require("../middleware/requirePermission");

router.get("/", requirePermission("referrals:view"), listReferrals);
router.post("/", requirePermission("referrals:create"), createReferral);
router.post("/:id/convert", requirePermission("referrals:create"), convertReferral);

module.exports = router;
