const express = require("express");
const router = express.Router();
const { callback } = require("../controller/partnerSocialController");

router.get("/:platform/callback", callback);

module.exports = router;
