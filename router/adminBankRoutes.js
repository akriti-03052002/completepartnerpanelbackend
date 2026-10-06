const express = require("express");
const router = express.Router();

const {
  listPendingBankAccounts, verifyBankAccount, revealBankAccount, approveBankAccountChange, rejectBankAccountChange
} = require("../controller/adminBankController");
const requireAdminRole = require("../middleware/requireAdminRole");

router.get("/pending", requireAdminRole("kyc_reviewer", "finance"), listPendingBankAccounts);
router.patch("/:id/verify", requireAdminRole("kyc_reviewer"), verifyBankAccount);
router.get("/:id/reveal", requireAdminRole("finance"), revealBankAccount);
router.patch("/:id/change/approve", requireAdminRole("kyc_reviewer"), approveBankAccountChange);
router.patch("/:id/change/reject", requireAdminRole("kyc_reviewer"), rejectBankAccountChange);

module.exports = router;
