const express = require("express");
const router = express.Router();

const { getBankAccount, upsertBankAccount, initiateBankVerification, confirmBankVerification, recordBankVerificationFailure } = require("../controller/partnerBankController");
const requirePermission = require("../middleware/requirePermission");

router.get("/", requirePermission("bank:view"), getBankAccount);
router.put("/", requirePermission("bank:manage"), upsertBankAccount);
router.post("/verify", requirePermission("bank:manage"), initiateBankVerification);
router.post("/verify/confirm", requirePermission("bank:manage"), confirmBankVerification);
router.post("/verify/failure", requirePermission("bank:manage"), recordBankVerificationFailure);

module.exports = router;
