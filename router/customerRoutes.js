const MongoRateLimitStore = require("../utils/MongoRateLimitStore");
const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();

const { getProfile, updateProfile, changePassword, listInvoices } = require("../controller/customerController");
const { listScreens, createScreen, deleteScreen } = require("../controller/customerScreenController");
const { getSubscription, createCheckoutOrder, verifyCheckoutPayment, recordCheckoutFailure } = require("../controller/customerSubscriptionController");

// Each of these calls out to Razorpay's API — caps abuse (and runaway
// external API usage) without getting in the way of a legitimate customer
// retrying a declined payment a few times.
const checkoutLimiter = rateLimit({
  store: new MongoRateLimitStore("customer-checkout"),
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many payment attempts. Please wait a few minutes and try again." }
});

router.get("/profile", getProfile);
router.patch("/profile", updateProfile);
router.post("/change-password", changePassword);
router.get("/invoices", listInvoices);

router.get("/screens", listScreens);
router.post("/screens", createScreen);
router.delete("/screens/:id", deleteScreen);

router.get("/subscription", getSubscription);
router.post("/subscription/checkout", checkoutLimiter, createCheckoutOrder);
router.post("/subscription/verify", checkoutLimiter, verifyCheckoutPayment);
router.post("/subscription/payment-failed", checkoutLimiter, recordCheckoutFailure);

module.exports = router;
