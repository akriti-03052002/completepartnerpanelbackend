const express = require("express");
const router = express.Router();
const { startConnection, refreshAccount } = require("../controller/partnerSocialController");

router.get("/:platform/start", startConnection);
router.post("/accounts/:accountId/refresh", refreshAccount);

module.exports = router;
