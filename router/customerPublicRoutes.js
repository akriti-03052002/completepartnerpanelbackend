const express = require("express");
const rateLimit = require("express-rate-limit");

const { lookupReferralCode, registerCustomer, loginCustomer, forgotCustomerPassword, resetCustomerPassword } = require("../controller/customerPublicController");
const router = express.Router();

const authLimiter = rateLimit({
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

module.exports = router;
