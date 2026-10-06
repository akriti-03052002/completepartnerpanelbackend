const mongoose = require("mongoose");
const { Schema, model } = mongoose;

/* ============================================================
   SCREEN PRICING
   Singleton — two global monthly price-per-screen plans for
   customer subscriptions. Admin-managed via
   /admin/config/screen-pricing.
============================================================ */

const ScreenPricingSchema = new Schema(
  {
    basicPricePerScreen: {
      type: Number,
      required: true,
      default: 499
    },
    premiumPricePerScreen: {
      type: Number,
      required: true,
      default: 999
    }
  },
  {
    timestamps: true
  }
);

module.exports = model("ScreenPricing", ScreenPricingSchema);
