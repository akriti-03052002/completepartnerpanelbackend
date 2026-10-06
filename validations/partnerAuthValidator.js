const { body } = require("express-validator");
const handleValidation = require("./handleValidation");
const { PARTNER_TYPES } = require("../config/constant");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sendEmailOtpValidator = [
  body("email")
    .exists({ checkFalsy: true }).withMessage("A valid email is required.")
    .bail()
    .isString().withMessage("A valid email is required.")
    .bail()
    .matches(EMAIL_PATTERN).withMessage("A valid email is required."),
  handleValidation
];

const verifyEmailOtpValidator = [
  body("email").exists({ checkFalsy: true }).isString().withMessage("Email and OTP are required."),
  body("otp").exists({ checkFalsy: true }).withMessage("Email and OTP are required."),
  handleValidation
];

// One registration form serves all four partner types — the type decides
// which workflows the partner gets afterwards.
const registerPartnerValidator = [
  body("partnerType")
    .exists({ checkFalsy: true }).withMessage("Partner type, name, email and phone are required.")
    .bail()
    .isIn(PARTNER_TYPES).withMessage("Choose a valid partner type: Influencer, Affiliate, Vendor or Reseller."),
  body("contactName").exists({ checkFalsy: true }).isString()
    .withMessage("Partner type, name, email and phone are required."),
  body("email")
    .exists({ checkFalsy: true }).withMessage("Partner type, name, email and phone are required.")
    .bail()
    .isString().matches(EMAIL_PATTERN).withMessage("A valid email is required."),
  body("phone").exists({ checkFalsy: true })
    .withMessage("Partner type, name, email and phone are required."),
  body("password")
    .exists({ checkFalsy: true }).withMessage("Password is required and must contain at least 8 characters.")
    .bail()
    .isString().isLength({ min: 8 }).withMessage("Password is required and must contain at least 8 characters."),
  handleValidation
];

const loginPartnerValidator = [
  body("email").exists({ checkFalsy: true }).isString().withMessage("Email and password are required."),
  body("password").exists({ checkFalsy: true }).isString().withMessage("Email and password are required."),
  handleValidation
];

const forgotPasswordValidator = [
  body("email").exists({ checkFalsy: true }).isString().withMessage("Email is required."),
  handleValidation
];

const resetPasswordValidator = [
  body("password")
    .exists({ checkFalsy: true }).withMessage("Password must be at least 8 characters.")
    .bail()
    .isString().isLength({ min: 8 }).withMessage("Password must be at least 8 characters."),
  handleValidation
];

module.exports = {
  sendEmailOtpValidator,
  verifyEmailOtpValidator,
  registerPartnerValidator,
  loginPartnerValidator,
  forgotPasswordValidator,
  resetPasswordValidator
};
