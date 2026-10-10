const { googleConfig, verifyGoogleIdentity, googleLogin } = require("../utils/googleIdentity");
const GoogleAccount = require("../models/Customer");
const MongoRateLimitStore = require("../utils/MongoRateLimitStore");
const express = require("express");
const rateLimit = require("express-rate-limit");

const { lookupReferralCode, registerCustomer, loginCustomer, forgotCustomerPassword, resetCustomerPassword } = require("../controller/customerPublicController");
const router = express.Router();

const authLimiter = rateLimit({
  store: new MongoRateLimitStore("customer-auth"),
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." }
});

router.get("/referral/:code", lookupReferralCode);
router.post("/register", authLimiter, registerCustomer);
router.post("/login", authLimiter, loginCustomer);
router.post("/forgot-password", authLimiter, forgotCustomerPassword);
router.post("/reset-password/:token", authLimiter, resetCustomerPassword);

router.get("/google/config", googleConfig);
router.post("/google/login", authLimiter, verifyGoogleIdentity, googleLogin(GoogleAccount, "email", loginCustomer));
router.post("/google/register", authLimiter, verifyGoogleIdentity, registerCustomer);

module.exports = router;
