const express = require("express");
const router = express.Router();
const requirePermission = require("../middleware/requirePermission");
const {
  listAccounts,
  submitAccount,
  listSubmissions,
  submitContent
} = require("../controller/partnerInfluencerController");

router.get("/accounts", requirePermission("profile:view"), listAccounts);
router.post("/accounts", requirePermission("profile:view"), submitAccount);
router.get("/posts", requirePermission("profile:view"), listSubmissions);
router.post("/posts", requirePermission("profile:view"), submitContent);

module.exports = router;
