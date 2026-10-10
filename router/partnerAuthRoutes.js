const { googleConfig, verifyGoogleIdentity, googleLogin } = require("../utils/googleIdentity");
const GoogleAccount = require("../models/Partneruser");
const MongoRateLimitStore = require("../utils/MongoRateLimitStore");
const express = require("express");
const rateLimit = require("express-rate-limit");

const { registerPartner, loginPartner, forgotPassword, resetPassword, sendEmailOtp, verifyEmailOtp } = require("../controller/partnerAuthController");
const {
  sendEmailOtpValidator,
  verifyEmailOtpValidator,
  registerPartnerValidator,
  loginPartnerValidator,
  forgotPasswordValidator,
  resetPasswordValidator
} = require("../validations/partnerAuthValidator");
const router = express.Router();

const authLimiter = rateLimit({
  store: new MongoRateLimitStore("partner-auth"),
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." }
});

// Tighter than authLimiter — this one emails an address the caller doesn't
// have to prove they own yet, so it's the more attractive spam target.
const otpLimiter = rateLimit({
  store: new MongoRateLimitStore("partner-otp"),
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many OTP requests. Please try again later." }
});

router.post("/register", authLimiter, registerPartnerValidator, registerPartner);
router.post("/login", authLimiter, loginPartnerValidator, loginPartner);
router.post("/forgot-password", authLimiter, forgotPasswordValidator, forgotPassword);
router.post("/reset-password/:token", authLimiter, resetPasswordValidator, resetPassword);
router.post("/send-otp", otpLimiter, sendEmailOtpValidator, sendEmailOtp);
router.post("/verify-otp", authLimiter, verifyEmailOtpValidator, verifyEmailOtp);

router.get("/google/config", googleConfig);
router.post("/google/login", authLimiter, verifyGoogleIdentity, googleLogin(GoogleAccount, "email", loginPartner));
router.post("/google/register", authLimiter, verifyGoogleIdentity, (req, res, next) => {
  if (!["vendor", "reseller", "affiliate", "influencer"].includes(req.body.partnerType) || typeof req.body.contactName !== "string" || !req.body.contactName.trim() || typeof req.body.phone !== "string" || !req.body.phone.trim()) return res.status(400).json({ success: false, message: "Choose a partner type and enter your name and phone number." });
  return next();
}, registerPartner);

module.exports = router;
