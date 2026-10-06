const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const { loginAdmin } = require("../controller/adminAuthController");
const { loginAdminValidator } = require("../validations/adminAuthValidator");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many attempts. Please try again later." }
});

router.post("/login", authLimiter, loginAdminValidator, loginAdmin);

module.exports = router;
