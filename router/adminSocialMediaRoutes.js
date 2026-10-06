const express = require("express");
const router = express.Router();
const requireAdminRole = require("../middleware/requireAdminRole");
const {
  listAccounts,
  reviewAccount,
  updateRates,
  listSubmissions,
  reviewSubmission
} = require("../controller/adminSocialMediaController");

router.get("/accounts", requireAdminRole("kyc_reviewer", "finance"), listAccounts);
router.patch("/accounts/:partnerId/:accountId/review", requireAdminRole("kyc_reviewer"), reviewAccount);
router.patch("/accounts/:partnerId/:accountId/rates", requireAdminRole("kyc_reviewer", "finance"), updateRates);
router.get("/posts", requireAdminRole("kyc_reviewer", "finance"), listSubmissions);
router.patch("/posts/:id/review", requireAdminRole("kyc_reviewer", "finance"), reviewSubmission);

module.exports = router;
