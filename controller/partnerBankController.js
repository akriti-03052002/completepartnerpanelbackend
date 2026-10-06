const { PartnerBankAccount, PartnerDocument } = require("../models/Index");
const { encrypt, maskAccountNumber, maskIfsc } = require("../utils/encryption");
const logActivity = require("../utils/logActivity");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;
const { holdSettlementsForPartner } = require("../utils/settlementHold");
const { createOrder, verifyPaymentSignature, fetchPaymentById, RazorpayLookupError } = require("../utils/razorpay");
const { applyBankVerificationPayment } = require("../services/partnerBankVerification");

// Razorpay's own floor for a chargeable order (100 paise = ₹1) — this
// verification payment is always exactly that.
const BANK_VERIFICATION_AMOUNT_PAISE = 100;

/* ============================================================
   PARTNER BANK ACCOUNT
   Raw account number / IFSC are never returned to the client —
   only masked values. Full encrypted fields carry `select: false`
   at the schema level as a second layer of protection.
============================================================ */

const maskPendingChange = (pendingChange) =>
  pendingChange
    ? {
        accountHolderName: pendingChange.accountHolderName,
        bankName: pendingChange.bankName,
        accountNumberLast4: pendingChange.accountNumberLast4,
        ifscMasked: pendingChange.ifscMasked,
        accountType: pendingChange.accountType,
        submittedAt: pendingChange.submittedAt,
        razorpayCheck: pendingChange.razorpayCheck
      }
    : null;

const getBankAccount = async (req, res) => {
  const bankAccount = await PartnerBankAccount.findOne({ partnerId: req.partner._id });

  if (!bankAccount) {
    return res.json({ success: true, data: null });
  }

  return res.json({
    success: true,
    data: {
      id: bankAccount._id,
      accountHolderName: bankAccount.accountHolderName,
      bankName: bankAccount.bankName,
      accountNumberLast4: bankAccount.accountNumberLast4,
      ifscMasked: bankAccount.ifscMasked,
      accountType: bankAccount.accountType,
      cancelledChequeDocumentId: bankAccount.cancelledChequeDocumentId,
      verification: bankAccount.verification,
      razorpayCheck: bankAccount.razorpayCheck,
      commissionEligibility: bankAccount.commissionEligibility,
      // Masked-only view of a staged update, if one is awaiting admin
      // review — the live fields above are never touched by it.
      pendingChange: maskPendingChange(bankAccount.pendingChange)
    }
  });
};

const upsertBankAccount = async (req, res) => {
  try {
    const { accountHolderName, bankName, accountNumber, ifsc, accountType, cancelledChequeDocumentId } = req.body;

    if (!accountHolderName || !bankName || !accountNumber || !ifsc || !accountType) {
      return res.status(400).json({ success: false, message: "All bank account fields are required." });
    }

    // The cancelled cheque isn't required to save bank details — it's an
    // optional KYC document uploaded separately from the Documents page.
    // If the partner has one on file (by ID here, or the most recent
    // cancelled_cheque upload otherwise), it's linked for the admin's
    // reference; if not, the bank account still saves.
    let chequeDocument = null;

    if (cancelledChequeDocumentId) {
      chequeDocument = await PartnerDocument.findOne({
        _id: cancelledChequeDocumentId,
        partnerId: req.partner._id,
        documentType: "cancelled_cheque"
      });

      if (!chequeDocument) {
        return res.status(400).json({ success: false, message: "Cancelled cheque document not found." });
      }
    } else {
      chequeDocument = await PartnerDocument.findOne({ partnerId: req.partner._id, documentType: "cancelled_cheque" })
        .sort({ createdAt: -1 });
    }

    const existingAccount = await PartnerBankAccount.findOne({ partnerId: req.partner._id });
    const wasVerified = existingAccount?.verification?.status === "verified";

    // A Reseller changing an already-verified account doesn't replace it —
    // the change is staged for an admin to approve, and the verified
    // account stays live in the meantime. (Every other partner type falls
    // through to the direct replace + payout hold below.)
    if (req.partner.partnerType === "reseller" && wasVerified) {
      existingAccount.pendingChange = {
        accountHolderName,
        bankName,
        accountType,
        accountNumberEncrypted: encrypt(accountNumber),
        accountNumberLast4: maskAccountNumber(accountNumber),
        ifscEncrypted: encrypt(ifsc),
        ifscMasked: maskIfsc(ifsc),
        cancelledChequeDocumentId: chequeDocument?._id,
        submittedAt: new Date(),
        razorpayCheck: { paymentStatus: "not_initiated" }
      };
      await existingAccount.save();

      await logActivity({
        partnerId: req.partner._id,
        performedByType: "partner_user",
        performedByUserId: req.partnerUser._id,
        activityType: "note",
        entityType: "PartnerBankAccount",
        entityId: existingAccount._id,
        description: `${req.partnerUser.name} submitted a bank account change for admin review.`,
        req
      });

      await notifyAdmins({
        type: "bank_change_requested",
        title: "Bank account change to review",
        message: `${partnerLabel(req.partner)} asked to change their verified bank account. The current account stays live until this is approved.`,
        link: "/admin/bank",
        audienceRoles: ["kyc_reviewer", "finance"],
        partnerId: req.partner._id,
        entityType: "PartnerBankAccount",
        entityId: existingAccount._id
      });

      return res.json({
        success: true,
        message: "Your bank account change has been submitted for admin review. Your existing account details are unaffected until it's approved.",
        data: {
          id: existingAccount._id,
          accountNumberLast4: existingAccount.accountNumberLast4,
          ifscMasked: existingAccount.ifscMasked,
          verification: existingAccount.verification,
          pendingChange: maskPendingChange(existingAccount.pendingChange)
        }
      });
    }

    const payload = {
      accountHolderName,
      bankName,
      accountType,
      accountNumberEncrypted: encrypt(accountNumber),
      accountNumberLast4: maskAccountNumber(accountNumber),
      ifscEncrypted: encrypt(ifsc),
      ifscMasked: maskIfsc(ifsc),
      cancelledChequeDocumentId: chequeDocument?._id,
      verification: { status: "pending" },
      // New/changed account details invalidate any prior Razorpay check —
      // it was run against the old account, not this one.
      razorpayCheck: { paymentStatus: "not_initiated" },
      commissionEligibility: "not_eligible",
      security: { encryptedAt: new Date(), keyVersion: "v1" }
    };

    const bankAccount = await PartnerBankAccount.findOneAndUpdate(
      { partnerId: req.partner._id },
      { $set: payload, $setOnInsert: { partnerId: req.partner._id } },
      { returnDocument: "after", upsert: true }
    );

    // Same first-submission transition as document upload — bank details
    // can legitimately be the first thing a partner submits. Kept in its
    // own try/catch: the bank account is already saved above, so a failure
    // here should never make the save look like it failed.
    try {
      if (req.partner.status === "draft") req.partner.status = "pending_verification";
      if (req.partner.verification.overallStatus === "not_submitted") req.partner.verification.overallStatus = "pending";
      await req.partner.save();
    } catch (statusError) {
      console.error("upsertBankAccount: partner status flip failed (bank account was still saved):", statusError);
    }

    // A previously verified account just got swapped out for an unverified
    // one — don't let any in-flight settlement pay out to the old details.
    if (wasVerified) {
      await holdSettlementsForPartner(req.partner._id, {
        code: "bank_change_pending",
        reason: "Bank account details were changed and the new account is pending re-verification.",
        req
      });
    }

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "note",
      entityType: "PartnerBankAccount",
      entityId: bankAccount._id,
      description: `${req.partnerUser.name} added/updated bank account details.`,
      req
    });

    await notifyAdmins({
      type: wasVerified ? "bank_details_changed" : "bank_details_submitted",
      title: wasVerified ? "Verified bank account changed" : "Bank details to review",
      message: wasVerified
        ? `${partnerLabel(req.partner)} replaced their verified bank account. Payouts are on hold until the new account is verified.`
        : `${partnerLabel(req.partner)} submitted bank account details for verification.`,
      link: "/admin/bank",
      audienceRoles: wasVerified ? ["kyc_reviewer", "finance"] : ["kyc_reviewer"],
      partnerId: req.partner._id,
      entityType: "PartnerBankAccount",
      entityId: bankAccount._id
    });

    return res.json({
      success: true,
      message: "Bank account saved. It will be verified before payouts are settled.",
      data: {
        id: bankAccount._id,
        accountNumberLast4: bankAccount.accountNumberLast4,
        ifscMasked: bankAccount.ifscMasked,
        verification: bankAccount.verification
      }
    });
  } catch (error) {
    console.error("upsertBankAccount error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong saving the bank account." });
  }
};

// Which account the ₹1 check is about: a Reseller's staged change if there
// is one, otherwise the account on file.
const checkTarget = (bankAccount) => bankAccount.pendingChange || bankAccount;

// Step 1: opens a ₹1 Razorpay Order (test mode during dev — same
// credentials/flow as the customer subscription checkout) for the partner
// to pay via the Checkout popup on the frontend. Paying it is what proves
// the account is real and lets Razorpay tell us which bank it went
// through (for netbanking) — see confirmBankVerification for what happens
// once Checkout reports success.
const initiateBankVerification = async (req, res) => {
  try {
    const bankAccount = await PartnerBankAccount.findOne({ partnerId: req.partner._id });

    if (!bankAccount) {
      return res.status(400).json({ success: false, message: "Add a bank account before requesting verification." });
    }

    // If a change is staged for admin review, verification runs against
    // THAT account (it's what is actually pending), not the still-live one.
    const target = checkTarget(bankAccount);

    if (!bankAccount.pendingChange && bankAccount.verification.status === "verified") {
      return res.status(400).json({ success: false, message: "This bank account is already verified." });
    }

    const order = await createOrder({
      amountInRupees: 1,
      receipt: `bankverify_${bankAccount._id}`,
      notes: {
        purpose: "partner_bank_verification",
        partnerId: String(req.partner._id),
        bankAccountId: String(bankAccount._id)
      }
    });

    target.razorpayCheck = {
      paymentStatus: "pending",
      orderId: order.id,
      paymentId: "",
      method: "",
      bankCode: "",
      matchedBankName: "",
      nameMatchStatus: "not_checked",
      failureReason: "",
      completedAt: undefined
    };
    await bankAccount.save();

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "note",
      entityType: "PartnerBankAccount",
      entityId: bankAccount._id,
      description: `${req.partnerUser.name} started a ₹1 Razorpay bank verification payment.`,
      req
    });

    return res.json({
      success: true,
      data: {
        orderId: order.id,
        amount: 1,
        currency: "INR",
        keyId: process.env.RAZORPAY_KEY_ID,
        prefill: {
          name: target.accountHolderName,
          email: req.partner.primaryContact?.email,
          contact: req.partner.primaryContact?.phone || ""
        }
      }
    });
  } catch (error) {
    if (error instanceof RazorpayLookupError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error("initiateBankVerification error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong starting bank verification." });
  }
};

// Step 2: called by the partner's browser right after the Razorpay
// Checkout popup reports success — same "verify signature, then
// independently re-fetch from Razorpay before trusting it" shape as
// customerSubscriptionController.verifyCheckoutPayment. Only once this (or
// the payment.captured webhook safety net) confirms a real captured ₹1
// payment does razorpayCheck get filled in — never on the strength of the
// popup's own success callback alone.
const confirmBankVerification = async (req, res) => {
  try {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;

    if (!orderId || !paymentId || !signature) {
      return res.status(400).json({ success: false, message: "Missing payment verification details." });
    }

    const bankAccount = await PartnerBankAccount.findOne({ partnerId: req.partner._id });
    if (!bankAccount) {
      return res.status(404).json({ success: false, message: "Bank account not found." });
    }

    const target = checkTarget(bankAccount);

    if (target.razorpayCheck?.paymentStatus === "captured" && target.razorpayCheck.orderId === orderId) {
      // Already fulfilled (e.g. the webhook beat this call to it).
      return res.json({ success: true, message: "Payment already confirmed.", data: { razorpayCheck: target.razorpayCheck } });
    }

    if (target.razorpayCheck?.orderId !== orderId) {
      return res.status(400).json({ success: false, message: "This verification attempt is no longer valid — please start again." });
    }

    if (!(await verifyPaymentSignature({ orderId, paymentId, signature }))) {
      target.razorpayCheck.paymentStatus = "failed";
      target.razorpayCheck.failureReason = "Signature verification failed.";
      await bankAccount.save();
      return res.status(400).json({ success: false, message: "Payment could not be verified. If any amount was debited, it will be refunded automatically by Razorpay." });
    }

    const payment = await fetchPaymentById(paymentId);

    if (payment.status !== "captured" || payment.order_id !== orderId || payment.amount !== BANK_VERIFICATION_AMOUNT_PAISE) {
      target.razorpayCheck.paymentStatus = "failed";
      target.razorpayCheck.failureReason = `Razorpay payment check failed (status: ${payment.status}).`;
      await bankAccount.save();
      return res.status(400).json({ success: false, message: "This payment couldn't be confirmed as captured for the correct amount." });
    }

    await applyBankVerificationPayment(bankAccount, payment);

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "note",
      entityType: "PartnerBankAccount",
      entityId: bankAccount._id,
      description: `${req.partnerUser.name}'s ₹1 bank verification payment was confirmed captured (bank match: ${target.razorpayCheck.nameMatchStatus}).`,
      req
    });

    return res.json({
      success: true,
      message: "Payment confirmed. An admin will now do a final review of your bank account.",
      data: { razorpayCheck: target.razorpayCheck }
    });
  } catch (error) {
    if (error instanceof RazorpayLookupError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error("confirmBankVerification error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong confirming your verification payment. Contact support with your payment ID if any amount was debited." });
  }
};

// Best-effort record of a declined/abandoned Checkout attempt (card
// declined, popup closed, etc) — mirrors
// customerSubscriptionController.recordCheckoutFailure. No money moved, so
// this never affects eligibility on its own; it just keeps the partner's
// status honest instead of stuck on "pending" indefinitely.
const recordBankVerificationFailure = async (req, res) => {
  try {
    const { code, description } = req.body;

    const bankAccount = await PartnerBankAccount.findOne({ partnerId: req.partner._id });
    if (!bankAccount) return res.json({ success: true });

    const target = checkTarget(bankAccount);
    if (target.razorpayCheck?.paymentStatus === "captured") {
      return res.json({ success: true });
    }

    target.razorpayCheck.paymentStatus = "failed";
    target.razorpayCheck.failureReason = description || "Payment was not completed.";
    await bankAccount.save();

    return res.json({ success: true });
  } catch (error) {
    console.error("recordBankVerificationFailure error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong." });
  }
};

module.exports = { getBankAccount, upsertBankAccount, initiateBankVerification, confirmBankVerification, recordBankVerificationFailure };
