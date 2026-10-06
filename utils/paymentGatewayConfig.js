const PaymentGatewaySetting = require("../models/PaymentGatewaySetting");
const { encrypt, decrypt } = require("./encryption");

/* ============================================================
   PAYMENT GATEWAY CONFIG RESOLUTION
   Single place that decides "what Razorpay credentials do we actually
   use right now" — DB-stored admin-panel config takes priority per
   field, falling back to the matching .env variable. utils/razorpay.js
   resolves through here instead of reading process.env directly, so an
   admin-panel edit takes effect immediately (next request) with no
   server restart, same as editing .env used to require.
============================================================ */

const getSetting = () =>
  PaymentGatewaySetting.findOne().select("+razorpay.keySecretEncrypted +razorpay.webhookSecretEncrypted");

const getRazorpayCredentials = async () => {
  const setting = await getSetting();

  return {
    keyId: setting?.razorpay?.keyId || process.env.RAZORPAY_KEY_ID || "",
    keySecret: setting?.razorpay?.keySecretEncrypted
      ? decrypt(setting.razorpay.keySecretEncrypted)
      : (process.env.RAZORPAY_KEY_SECRET || ""),
    webhookSecret: setting?.razorpay?.webhookSecretEncrypted
      ? decrypt(setting.razorpay.webhookSecretEncrypted)
      : (process.env.RAZORPAY_WEBHOOK_SECRET || "")
  };
};

// RazorpayX (payouts) uses the same Razorpay account keys unless separate
// RAZORPAYX_* keys are set. The account number (the RazorpayX current
// account money is paid FROM) is only needed to create payouts, not to look
// one up — so verifying a payout by its ID works with just the keys.
const getRazorpayXCredentials = async () => {
  const razorpay = await getRazorpayCredentials();
  return {
    keyId: process.env.RAZORPAYX_KEY_ID || razorpay.keyId,
    keySecret: process.env.RAZORPAYX_KEY_SECRET || razorpay.keySecret,
    accountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER || ""
  };
};

// Admin-panel view — deliberately never returns a decrypted secret, only
// whether one is set (DB or env) and, for the ones already shaped like an
// identifier rather than a true secret, a last-4 hint.
const getMaskedSettings = async () => {
  const setting = await PaymentGatewaySetting.findOne();
  const razorpayKeyId = setting?.razorpay?.keyId || process.env.RAZORPAY_KEY_ID || "";

  return {
    razorpay: {
      keyId: razorpayKeyId,
      keyIdSource: setting?.razorpay?.keyId ? "admin_panel" : (process.env.RAZORPAY_KEY_ID ? "env" : "unset"),
      keySecretConfigured: Boolean(setting?.razorpay?.keySecretLast4 || process.env.RAZORPAY_KEY_SECRET),
      keySecretLast4: setting?.razorpay?.keySecretLast4 || "",
      webhookSecretConfigured: Boolean(setting?.razorpay?.webhookSecretSet || process.env.RAZORPAY_WEBHOOK_SECRET)
    }
  };
};

// Only overwrites a field when a non-empty value is actually submitted —
// leaving a secret field blank in the form means "keep the existing one",
// not "clear it", so the admin never has to re-paste a secret just to
// change the Key ID next to it.
const updateSettings = async ({ razorpay = {} }, adminUserId) => {
  const $set = { updatedBy: adminUserId };

  if (razorpay.keyId !== undefined) $set["razorpay.keyId"] = razorpay.keyId;
  if (razorpay.keySecret) {
    $set["razorpay.keySecretEncrypted"] = encrypt(razorpay.keySecret);
    $set["razorpay.keySecretLast4"] = razorpay.keySecret.slice(-4);
  }
  if (razorpay.webhookSecret) {
    $set["razorpay.webhookSecretEncrypted"] = encrypt(razorpay.webhookSecret);
    $set["razorpay.webhookSecretSet"] = true;
  }

  return PaymentGatewaySetting.findOneAndUpdate({}, { $set }, { upsert: true, returnDocument: "after" });
};

module.exports = { getRazorpayCredentials, getRazorpayXCredentials, getMaskedSettings, updateSettings };
