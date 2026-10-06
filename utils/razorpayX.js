const crypto = require("crypto");
const { getRazorpayXCredentials } = require("./paymentGatewayConfig");

/* ============================================================
   RAZORPAYX — automated partner payouts
   A different Razorpay product from the payment gateway (utils/razorpay.js)
   — needs its own current account + credentials (RAZORPAYX_KEY_ID,
   RAZORPAYX_KEY_SECRET, RAZORPAYX_ACCOUNT_NUMBER), resolved via
   utils/paymentGatewayConfig (admin-panel DB config, falling back to
   .env — see that file for the precedence rule). isConfigured() is
   checked before every call site so this degrades to "not configured"
   rather than crashing when neither is set — see
   adminSettlementController.payoutViaRazorpayX.

   Flow: a Contact represents the partner, a Fund Account represents their
   bank account under that Contact, and a Payout actually moves money to a
   Fund Account. Contact + Fund Account are created once and cached (see
   models/PartnerRazorpayXAccount.js) since re-registering the same bank
   account on every payout would be wasteful and slower.
============================================================ */

const BASE_URL = "https://api.razorpay.com/v1";

class RazorpayXError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

const isConfigured = async () => {
  const { keyId, keySecret, accountNumber } = await getRazorpayXCredentials();
  return Boolean(keyId && keySecret && accountNumber);
};

const request = async (path, { method = "GET", body } = {}) => {
  const { keyId, keySecret, accountNumber } = await getRazorpayXCredentials();

  // The account number (which account to pay FROM) is only needed to
  // create a payout; looking one up by ID works with just the keys.
  const needsAccountNumber = path === "/payouts" && method !== "GET";
  if (!keyId || !keySecret || (needsAccountNumber && !accountNumber)) {
    throw new RazorpayXError("RazorpayX isn't configured — set the Key ID, Key Secret and Account Number (Admin -> Config -> Payment Gateway, or .env) to enable automated payouts.");
  }

  const authHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;

  // /payouts is the only endpoint that needs the RazorpayX account_number
  // itself (which account to pay FROM) — inject it here rather than
  // making every caller remember to pass it.
  const resolvedBody = path === "/payouts" && body ? { account_number: accountNumber, ...body } : body;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json"
    },
    body: resolvedBody ? JSON.stringify(resolvedBody) : undefined
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const description = data?.error?.description || `RazorpayX request failed (${response.status}).`;
    throw new RazorpayXError(description);
  }

  return data;
};

const createContact = ({ name, email, contact, referenceId }) =>
  request("/contacts", {
    method: "POST",
    body: {
      name,
      email: email || undefined,
      contact: contact || undefined,
      type: "vendor",
      reference_id: referenceId
    }
  });

const createFundAccount = ({ contactId, accountHolderName, ifsc, accountNumber }) =>
  request("/fund_accounts", {
    method: "POST",
    body: {
      contact_id: contactId,
      account_type: "bank_account",
      bank_account: {
        name: accountHolderName,
        ifsc,
        account_number: accountNumber
      }
    }
  });

// UPI mode needs a VPA-type fund account instead of a bank_account one —
// used for a one-off UPI payout where the admin types the partner's VPA
// in at payout time (not persisted, unlike the cached bank fund account —
// see adminSettlementController.payoutViaRazorpayX).
const createVpaFundAccount = ({ contactId, vpa }) =>
  request("/fund_accounts", {
    method: "POST",
    body: {
      contact_id: contactId,
      account_type: "vpa",
      vpa: { address: vpa }
    }
  });

// mode: "IMPS" | "NEFT" | "RTGS" | "UPI". queue_if_low_balance keeps the
// payout from hard-failing if the RazorpayX account balance is briefly
// short — Razorpay retries it automatically once funded instead.
const createPayout = ({ fundAccountId, amountInRupees, mode = "IMPS", referenceId, narration }) =>
  request("/payouts", {
    method: "POST",
    body: {
      fund_account_id: fundAccountId,
      amount: Math.round(amountInRupees * 100),
      currency: "INR",
      mode,
      purpose: "payout",
      queue_if_low_balance: true,
      reference_id: referenceId,
      narration: narration || "Partner commission settlement"
    }
  });

const fetchPayout = (payoutId) => request(`/payouts/${payoutId}`);

const fetchFundAccount = (fundAccountId) => request(`/fund_accounts/${encodeURIComponent(fundAccountId)}`);

const fingerprintBankAccount = (accountNumber, ifsc) =>
  crypto.createHash("sha256").update(`${accountNumber}:${ifsc}`).digest("hex");

module.exports = {
  RazorpayXError,
  isConfigured,
  createContact,
  createFundAccount,
  createVpaFundAccount,
  createPayout,
  fetchPayout,
  fetchFundAccount,
  fingerprintBankAccount
};
