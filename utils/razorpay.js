const crypto = require("crypto");
const Razorpay = require("razorpay");
const { getRazorpayCredentials } = require("./paymentGatewayConfig");

/* ============================================================
   RAZORPAY
   - fetchPaymentById: read-only lookup, used to treat Razorpay as the
     source of truth for whether a payment is real/captured. Used both by
     the customer subscription checkout (double-check after signature
     verification) and adminSettlementController's manual payout lookup.
   - createOrder / verifyPaymentSignature / verifyWebhookSignature: the
     customer subscription checkout flow — an order is created for the
     GST-inclusive total, the customer pays it via the Razorpay Checkout
     popup, and the result is verified two independent ways before
     anything is activated: the HMAC signature Checkout hands back, and a
     fetchPaymentById re-check that it's actually captured for the right
     amount (see services/customerPaymentFulfillment.js).

   Credentials are resolved fresh on every call via
   utils/paymentGatewayConfig (admin-panel DB config, falling back to
   .env) rather than read once at module load — an admin editing the
   Payment Gateway settings page takes effect on the very next request,
   no server restart needed. The Razorpay SDK client itself is cheap to
   construct (no network call), so building one per operation costs
   nothing meaningful.
============================================================ */

class RazorpayLookupError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

const getClient = async () => {
  const { keyId, keySecret } = await getRazorpayCredentials();
  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

/* Fetches a payment by its Razorpay payment ID (e.g. pay_xxx). Normalizes
   the SDK's "not found" error into a message safe to show an admin. */
const fetchPaymentById = async (paymentId) => {
  try {
    const razorpay = await getClient();
    return await razorpay.payments.fetch(paymentId);
  } catch (error) {
    const description = error?.error?.description || error.message;
    throw new RazorpayLookupError(`Couldn't find that payment on Razorpay: ${description}`);
  }
};

// amountInRupees is converted to paise here so callers never have to
// remember Razorpay's smallest-unit convention. payment_capture: 1 forces
// auto-capture regardless of the account's dashboard default — without it,
// an account set to manual capture would leave a fully successful payment
// sitting as "authorized" rather than "captured", which would make
// verifyCheckoutPayment's captured-status check wrongly treat it as failed.
const createOrder = async ({ amountInRupees, receipt, notes }) => {
  const razorpay = await getClient();
  return razorpay.orders.create({
    amount: Math.round(amountInRupees * 100),
    currency: "INR",
    receipt,
    notes,
    payment_capture: 1
  });
};

const timingSafeEqualHex = (a, b) => {
  const bufA = Buffer.from(a || "", "utf8");
  const bufB = Buffer.from(b || "", "utf8");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
};

// Checkout's success handler hands back order_id + payment_id + a
// signature that's HMAC-SHA256(order_id + "|" + payment_id) keyed with the
// account's key_secret — this is what proves the response actually came
// from Razorpay and wasn't forged client-side.
const verifyPaymentSignature = async ({ orderId, paymentId, signature }) => {
  const { keySecret } = await getRazorpayCredentials();
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return timingSafeEqualHex(expected, signature);
};

// Webhook payloads are signed with a separate secret (configured in the
// Razorpay Dashboard, not the account key_secret) over the raw request
// body — the caller must pass the untouched raw Buffer/string, not a
// re-serialized JSON.parse of it, or this will never match.
const verifyWebhookSignature = async ({ rawBody, signature }) => {
  const { webhookSecret } = await getRazorpayCredentials();
  const expected = crypto
    .createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");
  return timingSafeEqualHex(expected, signature);
};

module.exports = {
  fetchPaymentById,
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  RazorpayLookupError
};
