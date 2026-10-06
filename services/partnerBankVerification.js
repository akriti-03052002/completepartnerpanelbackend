const { Partner, PartnerNotification } = require("../models/Index");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;

/* ============================================================
   PARTNER BANK VERIFICATION — ₹1 CHECKOUT PAYMENT
   Shared between partnerBankController.confirmBankVerification (the
   browser calling back right after Razorpay Checkout succeeds) and
   razorpayWebhookController (the payment.captured safety net) — same
   "verify twice, apply once, idempotently" shape as
   services/customerPaymentFulfillment.js.

   Test-mode Checkout can't hand back a real bank account number/IFSC to
   cross-check (that needs RazorpayX Fund Account Validation, a separate
   product this app doesn't use in dev) — the closest signal available is
   which bank a netbanking test payment went through
   (`payment.bank`), which is compared against the bank name the partner
   typed. Any other method (UPI/card/wallet) can't be matched
   automatically at all — flagged `unverifiable` rather than guessed at,
   left for an admin to check by hand (see adminBankController
   .verifyBankAccount's override path).
============================================================ */

// Common Razorpay TEST-mode netbanking bank codes -> display name. Not
// exhaustive — an unrecognized code falls back to showing the raw code,
// which still lets an admin eyeball it manually.
const BANK_CODE_NAMES = {
  HDFC: "HDFC Bank",
  ICIC: "ICICI Bank",
  SBIN: "State Bank of India",
  UTIB: "Axis Bank",
  KKBK: "Kotak Mahindra Bank",
  PUNB: "Punjab National Bank",
  IDFB: "IDFC FIRST Bank",
  YESB: "Yes Bank",
  INDB: "IndusInd Bank",
  FDRL: "Federal Bank"
};

const normalize = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");

// Razorpay's test-mode netbanking codes often carry a variant suffix on top
// of the base bank code — e.g. "PUNB_R" (retail) vs "PUNB_C" (corporate) vs
// plain "PUNB" — that isn't itself a different bank. Rather than guess at
// one suffix shape, match by prefix against every known code (checked
// longest-first so e.g. a hypothetical "IDFB" vs "IDFBX" ambiguity always
// prefers the more specific/longer key).
const bankNameForCode = (code) => {
  const upper = String(code || "").toUpperCase();
  if (BANK_CODE_NAMES[upper]) return BANK_CODE_NAMES[upper];

  const prefixMatch = Object.keys(BANK_CODE_NAMES)
    .sort((a, b) => b.length - a.length)
    .find((key) => upper.startsWith(key));

  return prefixMatch ? BANK_CODE_NAMES[prefixMatch] : code;
};

const resolveBankMatch = (payment, enteredBankName) => {
  if (payment.method === "netbanking" && payment.bank) {
    const matchedBankName = bankNameForCode(payment.bank);
    const a = normalize(matchedBankName);
    const b = normalize(enteredBankName);
    const isMatch = Boolean(a) && Boolean(b) && (a.includes(b) || b.includes(a));

    return {
      nameMatchStatus: isMatch ? "matched" : "mismatched",
      matchedBankName,
      failureReason: isMatch ? "" : `Razorpay recorded this ₹1 test payment via ${matchedBankName} netbanking, which doesn't match the bank you entered (${enteredBankName}).`
    };
  }

  return {
    nameMatchStatus: "unverifiable",
    matchedBankName: "",
    failureReason: `Automatic bank matching only works for netbanking test payments (this one used ${payment.method || "another method"}) — an admin can verify this manually.`
  };
};

// Idempotent: safe to call twice for the same captured payment (browser
// /confirm call and the webhook can both reach this for the same payment).
const applyBankVerificationPayment = async (bankAccount, payment) => {
  // A Reseller's staged change has its own check — the payment belongs to
  // whichever account its order was opened for.
  const isPendingChange = Boolean(bankAccount.pendingChange) &&
    bankAccount.pendingChange.razorpayCheck?.orderId === payment.order_id;
  const target = isPendingChange ? bankAccount.pendingChange : bankAccount;

  if (target.razorpayCheck?.paymentStatus === "captured" && target.razorpayCheck?.paymentId === payment.id) {
    return bankAccount;
  }

  const match = resolveBankMatch(payment, target.bankName);

  target.razorpayCheck.paymentStatus = "captured";
  target.razorpayCheck.paymentId = payment.id;
  target.razorpayCheck.method = payment.method || "";
  target.razorpayCheck.bankCode = payment.bank || "";
  target.razorpayCheck.matchedBankName = match.matchedBankName;
  target.razorpayCheck.nameMatchStatus = match.nameMatchStatus;
  target.razorpayCheck.failureReason = match.failureReason;
  target.razorpayCheck.completedAt = new Date();
  await bankAccount.save();

  await PartnerNotification.create({
    partnerId: bankAccount.partnerId,
    type: "bank_verified",
    title: "Bank verification payment confirmed",
    message: match.nameMatchStatus === "matched"
      ? "Your ₹1 bank verification payment was confirmed and the bank matched what you entered. An admin will now do a final review."
      : match.failureReason,
    entity: { type: "PartnerBankAccount", entityId: bankAccount._id }
  });

  const partner = await Partner.findById(bankAccount.partnerId).select("partnerCode partnerType legalEntity.businessName primaryContact.name");
  await notifyAdmins({
    type: "bank_payment_confirmed",
    title: "Bank check payment received",
    message: `${partnerLabel(partner)} completed the ₹1 bank verification payment (bank match: ${match.nameMatchStatus.replace(/_/g, " ")}). Ready for review.`,
    link: "/admin/bank",
    audienceRoles: ["kyc_reviewer"],
    partnerId: bankAccount.partnerId,
    entityType: "PartnerBankAccount",
    entityId: bankAccount._id
  });

  return bankAccount;
};

module.exports = { applyBankVerificationPayment, resolveBankMatch };
