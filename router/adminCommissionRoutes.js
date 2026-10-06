const express = require("express");
const router = express.Router();

const { listCommissions, approveCommission, holdCommission, reverseCommission } = require("../controller/adminCommissionController");
const requireAdminRole = require("../middleware/requireAdminRole");

router.get("/", requireAdminRole("finance"), listCommissions);
router.patch("/:id/approve", requireAdminRole("finance"), approveCommission);
router.patch("/:id/hold", requireAdminRole("finance"), holdCommission);
router.patch("/:id/reverse", requireAdminRole("finance"), reverseCommission);

module.exports = router;
