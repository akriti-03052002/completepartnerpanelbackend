const express = require("express");
const router = express.Router();

const {
  lookupReferralCode, registerViaReferral, verifyAndSetPassword, loginCustomer
} = require("../controller/publicResellerCustomerController");

// No auth — this is a reseller's own customer signing themselves up,
// verifying their email, or logging into their own read-only portal.
router.get("/lookup/:code", lookupReferralCode);
router.post("/register", registerViaReferral);
router.post("/verify", verifyAndSetPassword);
router.post("/login", loginCustomer);

module.exports = router;
