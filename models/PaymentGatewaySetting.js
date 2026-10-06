const mongoose = require("mongoose");
const { Schema, model } = mongoose;

/* ============================================================
   PAYMENT GATEWAY SETTING (singleton — same findOne-or-create
   pattern as ScreenPricing)
   Lets an admin configure Razorpay credentials from the admin panel
   instead of editing .env by hand. Secrets (keySecret,
   webhookSecret) are encrypted at rest with the same AES-256-GCM
   utility that protects partner bank account numbers (utils/encryption.js)
   and are never selected by default — only decrypted transiently inside
   utils/paymentGatewayConfig.js when actually calling Razorpay's API.
   *Last4 fields exist purely so the admin UI can show "configured,
   ending ...1234" without ever re-exposing the real secret.

   This is an override layer, not a replacement for .env: if a field
   here is empty, utils/paymentGatewayConfig.js falls back to the
   matching environment variable — nothing breaks for an existing
   .env-only deployment.
============================================================ */

const PaymentGatewaySettingSchema = new Schema(
  {
    razorpay: {
      keyId: { type: String, default: "" },
      keySecretEncrypted: { type: String, default: "", select: false },
      keySecretLast4: { type: String, default: "" },
      webhookSecretEncrypted: { type: String, default: "", select: false },
      webhookSecretSet: { type: Boolean, default: false }
    },

    updatedBy: { type: Schema.Types.ObjectId, ref: "User" }
  },
  {
    timestamps: true
  }
);

module.exports = model("PaymentGatewaySetting", PaymentGatewaySettingSchema);
