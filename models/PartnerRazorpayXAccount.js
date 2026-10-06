const mongoose = require("mongoose");
const { Schema, model } = mongoose;
const ObjectId = Schema.Types.ObjectId;

/* ============================================================
   PARTNER RAZORPAYX ACCOUNT (cache)
   RazorpayX needs a "Contact" and a "Fund Account" registered before it
   can pay anyone — this caches the IDs so a partner's bank account only
   gets registered with RazorpayX once, not on every payout. See
   utils/razorpayX.js:getOrCreateFundAccount, which reads/writes this.

   bankAccountFingerprint (hash of the decrypted account number + IFSC) is
   what invalidates the cache if the partner's bank details change — a new
   fingerprint means a fresh fund account must be created and linked.
============================================================ */

const PartnerRazorpayXAccountSchema = new Schema(
  {
    partnerId: {
      type: ObjectId,
      ref: "Partner",
      required: true,
      unique: true,
      index: true
    },

    contactId: {
      type: String,
      required: true
    },

    fundAccountId: {
      type: String,
      required: true
    },

    bankAccountFingerprint: {
      type: String,
      required: true
    }
  },
  {
    timestamps: true
  }
);

module.exports = model("PartnerRazorpayXAccount", PartnerRazorpayXAccountSchema);
