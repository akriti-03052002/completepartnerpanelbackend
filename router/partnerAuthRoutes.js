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
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." }
});

// Tighter than authLimiter — this one emails an address the caller doesn't
// have to prove they own yet, so it's the more attractive spam target.
const otpLimiter = rateLimit({
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

module.exports = router;
