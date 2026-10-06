const express = require("express");
const router = express.Router();

const { getProfile, updateProfile } = require("../controller/partnerProfileController");
const requirePermission = require("../middleware/requirePermission");

router.get("/", requirePermission("profile:view"), getProfile);
router.patch("/", requirePermission("profile:update"), updateProfile);

module.exports = router;
