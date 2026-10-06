const express = require("express");
const router = express.Router();

const { listCustomers, markCustomerPaid, cancelCustomerSubscription, markCustomerExpired, resetCustomerCredentials } = require("../controller/adminCustomerController");
const requireAdminRole = require("../middleware/requireAdminRole");

router.get("/", requireAdminRole("finance", "kyc_reviewer"), listCustomers);
router.patch("/:id/mark-paid", requireAdminRole("finance"), markCustomerPaid);
router.patch("/:id/cancel", requireAdminRole("finance"), cancelCustomerSubscription);
router.patch("/:id/expire", requireAdminRole("finance"), markCustomerExpired);
router.post("/:id/reset-credentials", requireAdminRole("finance", "kyc_reviewer"), resetCustomerCredentials);

module.exports = router;
