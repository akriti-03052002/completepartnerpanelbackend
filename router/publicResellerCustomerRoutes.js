const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const MongoRateLimitStore = require("../utils/MongoRateLimitStore");
const authLimiter = rateLimit({ store: new MongoRateLimitStore("reseller-customer-auth"), windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { success: false, message: "Too many attempts. Please try again later." } });
router.use(authLimiter);

const {
  lookupReferralCode, registerViaReferral, verifyAndSetPassword, loginCustomer, requestPasswordLink
} = require("../controller/publicResellerCustomerController");

// No auth — this is a reseller's own customer signing themselves up,
// verifying their email, or logging into their own read-only portal.
router.get("/lookup/:code", lookupReferralCode);
router.post("/register", registerViaReferral);
router.post("/verify", verifyAndSetPassword);
router.post("/login", loginCustomer);
router.post("/forgot-password", requestPasswordLink);

module.exports = router;
