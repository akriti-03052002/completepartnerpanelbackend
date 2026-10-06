const { PartnerBankAccount, PartnerNotification } = require("../models/Index");
const { decrypt } = require("../utils/encryption");
const logActivity = require("../utils/logActivity");
const { autoActivatePartnerIfVerified } = require("../services/vendorActivation");
const { holdSettlementsForPartner, releaseSettlementsForPartnerByCodes } = require("../utils/settlementHold");

/* ============================================================
   ADMIN — BANK ACCOUNT VERIFICATION
============================================================ */

const listPendingBankAccounts = async (req, res) => {
  // New/changed accounts awaiting verification, plus verified Reseller
  // accounts with a staged change awaiting approval.
  const accounts = await PartnerBankAccount.find({
    $or: [{ "verification.status": "pending" }, { pendingChange: { $ne: null } }]
  })
    .sort({ createdAt: 1 })
    .populate("partnerId", "partnerCode partnerType legalEntity.businessName");

  return res.json({ success: true, data: accounts });
};

const verifyBankAccount = async (req, res) => {
  try {
    const { status, rejectionReason, overrideReason } = req.body;

    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be 'verified' or 'rejected'." });
    }

    const account = await PartnerBankAccount.findById(req.params.id);

    if (!account) {
      return res.status(404).json({ success: false, message: "Bank account not found." });
    }

    // The automated Razorpay check (₹1 verification payment) has to have
    // actually passed before an admin can mark this "verified" — unless
    // they explicitly override with a reason (e.g. the partner paid via
    // UPI/card so the bank couldn't be auto-matched, or a legitimate name
    // mismatch). Doesn't apply to rejections.
    const razorpayPassed = account.razorpayCheck?.paymentStatus === "captured" && account.razorpayCheck?.nameMatchStatus === "matched";

    if (status === "verified" && !razorpayPassed && !overrideReason?.trim()) {
      return res.status(400).json({
        success: false,
        message: "The Razorpay bank check hasn't passed yet (payment not captured or the name doesn't match). Ask the partner to run/re-run verification, or provide an override reason to proceed anyway."
      });
    }

    account.verification.status = status;
    account.verification.verifiedBy = req.adminUser._id;
    account.verification.verifiedAt = new Date();
    account.verification.rejectionReason = status === "rejected" ? rejectionReason || "" : "";
    account.verification.overrideReason = status === "verified" && !razorpayPassed ? overrideReason.trim() : "";
    account.commissionEligibility = status === "verified" ? "eligible" : "not_eligible";

    await account.save();

    if (status === "verified" && !razorpayPassed) {
      await logActivity({
        partnerId: account.partnerId,
        performedByType: "spotx_user",
        performedByUserId: req.adminUser._id,
        activityType: "note",
        entityType: "PartnerBankAccount",
        entityId: account._id,
        description: `${req.adminUser.name} verified this bank account despite the Razorpay check not passing. Override reason: ${account.verification.overrideReason}`,
        req
      });
    }

    await logActivity({
      partnerId: account.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "PartnerBankAccount",
      entityId: account._id,
      description: `${req.adminUser.name} marked the bank account as ${status}.`,
      req
    });

    await PartnerNotification.create({
      partnerId: account.partnerId,
      type: "bank_verified",
      title: `Bank account ${status}`,
      message: status === "rejected" && rejectionReason
        ? `Your bank account was rejected: ${rejectionReason}`
        : `Your bank account was ${status}.`,
      entity: { type: "PartnerBankAccount", entityId: account._id }
    });

    if (status === "verified") {
      await autoActivatePartnerIfVerified(account.partnerId, req.adminUser._id);

      // Bank is verified again — any settlement that was only on hold
      // because of this account can go through now.
      await releaseSettlementsForPartnerByCodes(
        account.partnerId,
        ["bank_unverified", "bank_change_pending"],
        { byUserId: req.adminUser._id, req }
      );
    } else {
      // Rejected — anything sitting in draft/pending/approved for this
      // partner can't be paid out to this account, so hold it too.
      await holdSettlementsForPartner(account.partnerId, {
        code: "bank_unverified",
        reason: rejectionReason ? `Bank account verification was rejected: ${rejectionReason}` : "Bank account verification was rejected.",
        byUserId: req.adminUser._id,
        req
      });
    }

    return res.json({ success: true, message: "Bank account reviewed.", data: account });
  } catch (error) {
    console.error("verifyBankAccount error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong reviewing the bank account." });
  }
};

/* Decrypts and reveals full account details — every reveal is audit-logged. */
const revealBankAccount = async (req, res) => {
  try {
    const account = await PartnerBankAccount.findById(req.params.id)
      .select("+accountNumberEncrypted +ifscEncrypted +pendingChange.accountNumberEncrypted +pendingChange.ifscEncrypted");

    if (!account) {
      return res.status(404).json({ success: false, message: "Bank account not found." });
    }

    // ?target=pending reveals the proposed replacement account a Reseller
    // has staged for review, not the still-live verified one.
    if (req.query.target === "pending") {
      if (!account.pendingChange) {
        return res.status(400).json({ success: false, message: "This bank account has no pending change." });
      }

      const pendingAccountNumber = decrypt(account.pendingChange.accountNumberEncrypted);
      const pendingIfsc = decrypt(account.pendingChange.ifscEncrypted);

      account.security.lastAccessedAt = new Date();
      account.security.lastAccessedBy = req.adminUser._id;
      await account.save();

      await logActivity({
        partnerId: account.partnerId,
        performedByType: "spotx_user",
        performedByUserId: req.adminUser._id,
        activityType: "bank_details_accessed",
        entityType: "PartnerBankAccount",
        entityId: account._id,
        description: `${req.adminUser.name} viewed the full details of a pending bank account change.`,
        req
      });

      return res.json({
        success: true,
        data: {
          accountNumber: pendingAccountNumber,
          ifsc: pendingIfsc,
          accountHolderName: account.pendingChange.accountHolderName,
          bankName: account.pendingChange.bankName
        }
      });
    }

    // Once verified, there's no review decision left to make — keep the
    // full account number/IFSC out of reach from that point on rather than
    // leaving them viewable indefinitely.
    if (account.verification.status === "verified") {
      return res.status(403).json({ success: false, message: "This bank account is already verified — full details can no longer be viewed." });
    }

    const accountNumber = decrypt(account.accountNumberEncrypted);
    const ifsc = decrypt(account.ifscEncrypted);

    account.security.lastAccessedAt = new Date();
    account.security.lastAccessedBy = req.adminUser._id;
    await account.save();

    await logActivity({
      partnerId: account.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "bank_details_accessed",
      entityType: "PartnerBankAccount",
      entityId: account._id,
      description: `${req.adminUser.name} viewed full bank account details.`,
      req
    });

    return res.json({
      success: true,
      data: { accountNumber, ifsc, accountHolderName: account.accountHolderName, bankName: account.bankName }
    });
  } catch (error) {
    console.error("revealBankAccount error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong revealing the bank account." });
  }
};

/* Approves a Reseller's staged bank account change: the proposed details
   become the live, verified account. Same rule as verifying a new account
   — the ₹1 Razorpay check on the proposed account has to have passed,
   unless the admin overrides it with a reason. */
const approveBankAccountChange = async (req, res) => {
  try {
    const account = await PartnerBankAccount.findById(req.params.id)
      .select("+pendingChange.accountNumberEncrypted +pendingChange.ifscEncrypted");

    if (!account) {
      return res.status(404).json({ success: false, message: "Bank account not found." });
    }

    if (!account.pendingChange) {
      return res.status(400).json({ success: false, message: "This bank account has no pending change to approve." });
    }

    const pending = account.pendingChange;
    const overrideReason = String(req.body.overrideReason || "").trim();
    const razorpayPassed = pending.razorpayCheck?.paymentStatus === "captured" && pending.razorpayCheck?.nameMatchStatus === "matched";

    if (!razorpayPassed && !overrideReason) {
      return res.status(400).json({
        success: false,
        message: "The Razorpay bank check hasn't passed yet for this pending change (payment not captured or the bank doesn't match). Ask the partner to run/re-run verification, or provide an override reason to proceed anyway."
      });
    }

    account.accountHolderName = pending.accountHolderName;
    account.bankName = pending.bankName;
    account.accountNumberEncrypted = pending.accountNumberEncrypted;
    account.accountNumberLast4 = pending.accountNumberLast4;
    account.ifscEncrypted = pending.ifscEncrypted;
    account.ifscMasked = pending.ifscMasked;
    account.accountType = pending.accountType;
    account.cancelledChequeDocumentId = pending.cancelledChequeDocumentId;
    account.razorpayCheck = pending.razorpayCheck;
    account.security.encryptedAt = new Date();
    account.security.keyVersion = "v1";

    account.verification.status = "verified";
    account.verification.verifiedBy = req.adminUser._id;
    account.verification.verifiedAt = new Date();
    account.verification.rejectionReason = "";
    account.verification.overrideReason = razorpayPassed ? "" : overrideReason;
    account.commissionEligibility = "eligible";

    account.pendingChange = null;

    await account.save();

    await logActivity({
      partnerId: account.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "PartnerBankAccount",
      entityId: account._id,
      description: `${req.adminUser.name} approved a pending bank account change${razorpayPassed ? "" : ` despite the Razorpay check not passing. Override reason: ${overrideReason}`}.`,
      req
    });

    await PartnerNotification.create({
      partnerId: account.partnerId,
      type: "bank_update_approved",
      title: "Bank account update approved",
      message: "Your bank account update was reviewed and approved. Your bank details have been updated.",
      entity: { type: "PartnerBankAccount", entityId: account._id }
    });

    await autoActivatePartnerIfVerified(account.partnerId, req.adminUser._id);

    return res.json({ success: true, message: "Bank account change approved.", data: account });
  } catch (error) {
    console.error("approveBankAccountChange error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong approving the bank account change." });
  }
};

const rejectBankAccountChange = async (req, res) => {
  try {
    const rejectionReason = String(req.body.rejectionReason || "").trim();

    const account = await PartnerBankAccount.findById(req.params.id);

    if (!account) {
      return res.status(404).json({ success: false, message: "Bank account not found." });
    }

    if (!account.pendingChange) {
      return res.status(400).json({ success: false, message: "This bank account has no pending change to reject." });
    }

    account.pendingChange = null;
    await account.save();

    await logActivity({
      partnerId: account.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "PartnerBankAccount",
      entityId: account._id,
      description: `${req.adminUser.name} rejected a pending bank account change.${rejectionReason ? ` Reason: ${rejectionReason}` : ""}`,
      req
    });

    await PartnerNotification.create({
      partnerId: account.partnerId,
      type: "bank_update_rejected",
      title: "Bank account update rejected",
      message: rejectionReason
        ? `Your bank account update was rejected: ${rejectionReason}`
        : "Your bank account update was rejected. Your existing bank details remain unchanged.",
      entity: { type: "PartnerBankAccount", entityId: account._id }
    });

    return res.json({ success: true, message: "Bank account change rejected.", data: account });
  } catch (error) {
    console.error("rejectBankAccountChange error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong rejecting the bank account change." });
  }
};

module.exports = { listPendingBankAccounts, verifyBankAccount, revealBankAccount, approveBankAccountChange, rejectBankAccountChange };
