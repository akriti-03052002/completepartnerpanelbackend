const mongoose = require("mongoose");
const { Partner, PartnerSettlement, PartnerCommission, SettlementSetting, PartnerNotification, PartnerBankAccount } = require("../models/Index");
const { PARTNER_TYPES } = require("../config/constant");
const PartnerSettlementBill = require("../models/PartnerSettlementBill");
const { generateSettlementNumber } = require("../utils/generateCode");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");
const { earningNounFor, capitalize, rupees } = notifyPartner;
const { sendStoredFile } = require("../utils/fileStorage");
const { recordSettlementHistory, getSettlementHistory } = require("../utils/settlementHistory");
const {
  checkSettlementPayoutReadiness, putSettlementOnHold,
  releaseSettlementHold, HoldReleaseError
} = require("../utils/settlementHold");
const { fetchPaymentById, RazorpayLookupError } = require("../utils/razorpay");
const { finalizeSettlementPaid, computePayableAmount } = require("../services/settlementPayoutFulfillment");
const { getPartnerBankDetails, verifyOnlinePayout } = require("../services/onlinePayoutVerification");
const { RazorpayXError } = require("../utils/razorpayX");

// A RazorpayX payout ("pout_...") is money SPOTX sent out to the partner; a
// Razorpay payment ("pay_...") is money collected through the gateway. Both
// can settle a batch, but they're verified against different APIs.
const isPayoutId = (transactionId) => /^pout_/i.test(String(transactionId || "").trim());

/* ============================================================
   ADMIN — SETTLEMENT / PAYOUT BATCHES
============================================================ */

// Read-only lookup so the admin can see what a Razorpay payment ID actually
// is — amount, status, method — before committing to marking a settlement
// paid with it. Doesn't touch the settlement; markSettlementPaid re-fetches
// and re-validates independently, this is just the preview step.
const fetchRazorpayPayment = async (req, res) => {
  try {
    const payment = await fetchPaymentById(req.params.paymentId);

    return res.json({
      success: true,
      data: {
        id: payment.id,
        status: payment.status,
        amount: payment.amount / 100,
        currency: payment.currency,
        method: payment.method,
        email: payment.email,
        contact: payment.contact,
        createdAt: payment.created_at ? new Date(payment.created_at * 1000) : null
      }
    });
  } catch (error) {
    if (error instanceof RazorpayLookupError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error("fetchRazorpayPayment error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong fetching the payment from Razorpay." });
  }
};

// The partner's full bank account + the amount payable, so the admin can
// pay this settlement online. Decrypts the account number, so every view
// is audit-logged — same as adminBankController.revealBankAccount.
const getPayoutDetails = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Settlement not found." });
    }
    const settlement = await PartnerSettlement.findById(req.params.id);
    if (!settlement) return res.status(404).json({ success: false, message: "Settlement not found." });

    const [bank, payable] = await Promise.all([getPartnerBankDetails(settlement.partnerId), computePayableAmount(settlement)]);

    if (bank) {
      await logActivity({
        partnerId: settlement.partnerId,
        performedByType: "spotx_user",
        performedByUserId: req.adminUser._id,
        activityType: "bank_details_accessed",
        entityType: "PartnerSettlement",
        entityId: settlement._id,
        description: `${req.adminUser.name} viewed bank details to pay settlement ${settlement.settlementNumber}.`,
        req
      });
    }

    return res.json({ success: true, data: { settlementNumber: settlement.settlementNumber, payable, bank } });
  } catch (error) {
    console.error("getPayoutDetails error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong loading the payout details." });
  }
};

// Looks up a RazorpayX payout ID and reports whether it matches this
// settlement (processed, right amount, right bank account) — the preview
// step before markSettlementPaid, which re-verifies independently.
const checkOnlinePayout = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Settlement not found." });
    }
    const settlement = await PartnerSettlement.findById(req.params.id);
    if (!settlement) return res.status(404).json({ success: false, message: "Settlement not found." });
    return res.json({ success: true, data: await verifyOnlinePayout(settlement, req.query.transactionId) });
  } catch (error) {
    if (error instanceof RazorpayXError) return res.status(error.statusCode).json({ success: false, message: error.message });
    console.error("checkOnlinePayout error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong checking this transaction." });
  }
};

// Bank details are a separate, access-restricted collection (see
// PartnerBankAccount) — only the pre-masked fields (bankName,
// accountNumberLast4, ifscMasked) are safe to surface here, never the
// encrypted account number/IFSC.
const attachMaskedBankAccounts = async (settlements) => {
  const partnerIds = [...new Set(
    settlements
      .map((s) => s.partnerId?._id || s.partnerId)
      .filter((id) => id && mongoose.isValidObjectId(id))
      .map(String)
  )];

  if (partnerIds.length === 0) {
    return settlements.map((s) => ({ ...s, bankAccount: null }));
  }

  const accounts = await PartnerBankAccount.find(
    { partnerId: { $in: partnerIds } },
    "partnerId bankName accountNumberLast4 ifscMasked"
  ).lean();

  const byPartnerId = new Map(accounts.map((a) => [String(a.partnerId), a]));

  return settlements.map((s) => ({
    ...s,
    bankAccount: byPartnerId.get(String(s.partnerId?._id || s.partnerId)) || null
  }));
};

// One bill per settlement (see PartnerSettlementBill's unique index) — a
// single query keyed by settlementId is enough to attach each row's bill
// (or null, for partners who aren't GST-registered and never needed one).
const attachBills = async (settlements) => {
  const settlementIds = settlements.map((s) => s._id);

  const bills = await PartnerSettlementBill.find(
    { settlementId: { $in: settlementIds } },
    "settlementId billNumber status amount.gstRatePercent amount.gstAmount amount.totalBillAmount file.originalName"
  ).lean();

  const bySettlementId = new Map(bills.map((b) => [String(b.settlementId), b]));

  return settlements.map((s) => ({
    ...s,
    bill: bySettlementId.get(String(s._id)) || null
  }));
};

const listSettlements = async (req, res) => {
  const { status, partnerId, partnerType } = req.query;

  if (partnerId && !mongoose.isValidObjectId(partnerId)) {
    return res.status(400).json({ success: false, message: "Invalid partner ID." });
  }

  const filter = {};
  if (status) filter.status = status;
  if (partnerId) filter.partnerId = partnerId;

  if (partnerType) {
    if (!PARTNER_TYPES.includes(partnerType)) {
      return res.status(400).json({ success: false, message: "Invalid partner type." });
    }

    const matchingPartnerIds = await Partner.find({ partnerType }).distinct("_id");
    if (partnerId && !matchingPartnerIds.some((id) => String(id) === partnerId)) {
      return res.json({ success: true, data: [] });
    }
    filter.partnerId = partnerId || { $in: matchingPartnerIds };
    if (matchingPartnerIds.length === 0) {
      return res.json({ success: true, data: [] });
    }
  }

  const settlements = await PartnerSettlement.find(filter)
    .sort({ createdAt: -1 })
    .populate("partnerId", "partnerCode partnerType legalEntity.businessName")
    .lean();

  return res.json({ success: true, data: await attachBills(await attachMaskedBankAccounts(settlements)) });
};

/* Bundles a partner's approved commissions into a draft settlement batch.
   Not part of the normal flow any more — settlements are built
   automatically when a commission is approved (services/autoSettlement.js).
   Kept as a fallback for anything approved that never got a settlement. */
const createSettlement = async (req, res) => {
  try {
    const { partnerId, commissionIds, periodFrom, periodTo } = req.body;

    if (!partnerId || !Array.isArray(commissionIds) || commissionIds.length === 0) {
      return res.status(400).json({ success: false, message: "partnerId and at least one commissionId are required." });
    }

    const commissions = await PartnerCommission.find({
      _id: { $in: commissionIds },
      partnerId,
      "settlement.status": "approved"
    });

    if (commissions.length === 0) {
      return res.status(400).json({ success: false, message: "No approved commissions found for this selection." });
    }

    const gross = commissions.reduce((sum, c) => sum + c.calculation.netCommission, 0);

    const settlementSetting = await SettlementSetting.findOne({ partnerId });
    const tdsRate = settlementSetting?.tax?.tdsEnabled ? settlementSetting.tax.tdsRate : 0;
    const tdsAmount = (gross * tdsRate) / 100;
    const net = gross - tdsAmount;

    const settlement = await PartnerSettlement.create({
      settlementNumber: generateSettlementNumber(),
      partnerId,
      commissionIds: commissions.map((c) => c._id),
      period: { from: periodFrom || undefined, to: periodTo || undefined },
      settlementType: settlementSetting?.settlementType || "manual",
      amount: { gross, deductions: tdsAmount, net, currency: "INR" },
      tax: { tdsRate, tdsAmount },
      status: "draft"
    });

    await PartnerCommission.updateMany(
      { _id: { $in: commissions.map((c) => c._id) } },
      { $set: { "settlement.status": "eligible", "settlement.settlementId": settlement._id } }
    );

    await recordSettlementHistory(settlement, {
      action: "created",
      toStatus: "draft",
      amount: { net, gst: 0, total: net, currency: "INR" },
      meta: { commissionCount: commissions.length },
      byUserId: req.adminUser._id,
      req
    });

    await logActivity({
      partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "settlement_created",
      entityType: "PartnerSettlement",
      entityId: settlement._id,
      description: `${req.adminUser.name} created a settlement batch of ${net.toFixed(2)}.`,
      req
    });

    // Told to the partner whether or not it then goes on hold below — a
    // hold sends its own notification saying why.
    const noun = await earningNounFor(settlement.partnerId);
    await notifyPartner({
      partnerId: settlement.partnerId,
      type: "settlement_created",
      title: "Settlement created",
      message: `Settlement ${settlement.settlementNumber} was created for ${settlement.commissionIds.length} ${noun}${settlement.commissionIds.length === 1 ? "" : "s"} totalling ${rupees(settlement.amount.net)}. It will be paid after SPOTX approves it.`,
      entityType: "PartnerSettlement",
      entityId: settlement._id
    });

    // Bank invalid/unverified, partner suspended/under review, no bank
    // account on file, or (new) GST-registered with no verified bill yet
    // — don't leave a payable-looking batch sitting in draft, put it on
    // hold immediately so admin/partner both see why.
    const eligibility = await checkSettlementPayoutReadiness(settlement);
    if (!eligibility.eligible) {
      await putSettlementOnHold(settlement, { code: eligibility.code, reason: eligibility.reason, byUserId: req.adminUser._id, req });
      return res.status(201).json({
        success: true,
        message: `Settlement batch created, but placed on hold: ${eligibility.reason}`,
        data: settlement
      });
    }

    return res.status(201).json({ success: true, message: "Settlement batch created.", data: settlement });
  } catch (error) {
    console.error("createSettlement error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong creating the settlement." });
  }
};

const approveSettlement = async (req, res) => {
  const settlement = await PartnerSettlement.findById(req.params.id);

  if (!settlement) {
    return res.status(404).json({ success: false, message: "Settlement not found." });
  }

  if (settlement.status === "on_hold") {
    return res.status(400).json({ success: false, message: "Settlement is on hold — release the hold before approving it." });
  }

  if (!["draft", "pending_approval"].includes(settlement.status)) {
    return res.status(400).json({ success: false, message: `Settlement is already ${settlement.status}.` });
  }

  // Re-check right before approving — the partner may have been suspended,
  // put under review, had their bank account invalidated, or (new) still
  // not have a verified GST bill on file since this batch was drafted.
  const eligibility = await checkSettlementPayoutReadiness(settlement);
  if (!eligibility.eligible) {
    await putSettlementOnHold(settlement, { code: eligibility.code, reason: eligibility.reason, byUserId: req.adminUser._id, req });
    return res.json({ success: true, message: `Settlement placed on hold instead of approved: ${eligibility.reason}`, data: settlement });
  }

  const fromStatus = settlement.status;
  settlement.status = "approved";
  settlement.approvedBy = req.adminUser._id;
  settlement.approvedAt = new Date();
  await settlement.save();

  await recordSettlementHistory(settlement, {
    action: "approved",
    fromStatus,
    toStatus: "approved",
    byUserId: req.adminUser._id,
    req
  });

  await notifyPartner({
    partnerId: settlement.partnerId,
    type: "settlement_approved",
    title: "Settlement approved",
    message: `Settlement ${settlement.settlementNumber} (${rupees(settlement.amount.net)}) was approved and is ready to be paid to your bank account.`,
    entityType: "PartnerSettlement",
    entityId: settlement._id
  });

  return res.json({ success: true, message: "Settlement approved.", data: settlement });
};

// Shared precondition check for all three payment paths below — approved
// status + full readiness (bank/partner eligibility + GST bill, if
// required). Returns the settlement on success, or null after already
// having written a response (either an error or a hold).
const guardBeforePayout = async (req, res) => {
  const settlement = await PartnerSettlement.findById(req.params.id);

  if (!settlement) {
    res.status(404).json({ success: false, message: "Settlement not found." });
    return null;
  }

  if (settlement.status !== "approved") {
    res.status(400).json({ success: false, message: "Only an approved settlement can be paid." });
    return null;
  }

  // Last check before money actually moves — the bank account could've
  // been invalidated, the partner suspended, or a GST bill gone
  // unverified since approval.
  const eligibility = await checkSettlementPayoutReadiness(settlement);
  if (!eligibility.eligible) {
    await putSettlementOnHold(settlement, { code: eligibility.code, reason: eligibility.reason, byUserId: req.adminUser._id, req });
    res.json({ success: true, message: `Settlement placed on hold instead of paid: ${eligibility.reason}`, data: settlement });
    return null;
  }

  return settlement;
};

// PATH 1 — Offline: admin paid the partner directly (bank transfer/UPI/
// cheque/cash) outside Razorpay entirely. No Razorpay artifact exists to
// verify, so this is trusted on the admin's word — same trust model as
// every other admin-attested action in this app. Still gated by the exact
// same readiness check (bank eligibility + GST bill) as the other two paths.
const markSettlementPaidOffline = async (req, res) => {
  try {
    const { method, referenceNumber, paidAt, note } = req.body;

    if (!["bank_transfer", "upi", "cheque", "cash", "other"].includes(method) || typeof referenceNumber !== "string" || !referenceNumber.trim()) {
      return res.status(400).json({ success: false, message: "A payment method and reference number are required." });
    }

    const chequeStatus = req.body.chequeStatus || "cleared";
    if (method === "cheque" && !["received", "cleared", "bounced"].includes(chequeStatus)) return res.status(400).json({ success: false, message: "Invalid cheque status." });

    const settlement = await guardBeforePayout(req, res);
    if (!settlement) return;

    const payable = await computePayableAmount(settlement);

    if (method === "cheque") {
      settlement.cheque = { number: referenceNumber.trim(), status: chequeStatus, updatedAt: new Date(), updatedBy: req.adminUser._id };
      if (chequeStatus !== "cleared") {
        const changed = await PartnerSettlement.findOneAndUpdate({ _id: settlement._id, status: "approved" }, { $set: { cheque: settlement.cheque } }, { returnDocument: "after", runValidators: true });
        if (!changed) return res.status(409).json({ success: false, message: "Settlement was already processed." });
        await recordSettlementHistory(changed, { action: `cheque_${chequeStatus}`, fromStatus: settlement.status, toStatus: settlement.status, amount: { total: payable.total, net: payable.net, gst: payable.gst }, meta: { method, transactionId: referenceNumber.trim() }, byUserId: req.adminUser._id, req });
        return res.json({ success: true, message: `Cheque ${chequeStatus} recorded. Settlement remains unpaid.`, data: settlement });
      }
    }

    await finalizeSettlementPaid(settlement, {
      method,
      transactionId: referenceNumber,
      paidAt: paidAt ? new Date(paidAt) : new Date(),
      payableTotal: payable.total,
      byUserId: req.adminUser._id,
      req
    });

    if (note) {
      await logActivity({
        partnerId: settlement.partnerId,
        performedByType: "spotx_user",
        performedByUserId: req.adminUser._id,
        activityType: "settlement_paid",
        entityType: "PartnerSettlement",
        entityId: settlement._id,
        description: `Offline payment note: ${note}`,
        req
      });
    }

    return res.json({ success: true, message: "Settlement marked paid (offline).", data: settlement });
  } catch (error) {
    console.error("markSettlementPaidOffline error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Something went wrong marking the settlement paid." });
  }
};

// PATH 2 — Razorpay verify: "transactionId" is a Razorpay payment ID
// (pay_xxx) — never taken on the admin's word. It's fetched from Razorpay
// and used as the source of truth for whether it's real, captured, and
// for the right amount (net commission + GST, if a verified bill exists),
// before the settlement is ever marked paid.
const markSettlementPaid = async (req, res) => {
  try {
    const { transactionId } = req.body;

    if (!transactionId) {
      return res.status(400).json({ success: false, message: "A Razorpay payment ID is required." });
    }

    const settlement = await guardBeforePayout(req, res);
    if (!settlement) return;

    // Paid out through RazorpayX: only marked paid if RazorpayX confirms
    // the payout was processed, for the payable amount, to this partner's
    // account number.
    if (isPayoutId(transactionId)) {
      const result = await verifyOnlinePayout(settlement, transactionId);
      if (!result.ok) {
        return res.status(400).json({ success: false, message: `Can't mark paid: ${result.problems.join(" ")}`, data: result });
      }

      await finalizeSettlementPaid(settlement, {
        method: "bank_transfer",
        verifiedOnline: true,
        transactionId: result.payout.id,
        paidAt: result.payout.createdAt || new Date(),
        payableTotal: result.payout.expectedAmount,
        byUserId: req.adminUser._id,
        req
      });

      return res.json({ success: true, message: "Settlement marked paid.", data: settlement });
    }

    const payment = await fetchPaymentById(transactionId);

    if (payment.status !== "captured") {
      return res.status(400).json({
        success: false,
        message: `Razorpay payment status is "${payment.status}", not captured — this settlement can't be marked paid from it.`
      });
    }

    const payable = await computePayableAmount(settlement);

    // Razorpay amounts are in paise; allow a ~1 rupee rounding gap before
    // treating it as the wrong payment ID.
    const paidAmount = payment.amount / 100;
    if (Math.abs(paidAmount - payable.total) > 1) {
      return res.status(400).json({
        success: false,
        message: `Razorpay payment amount (₹${paidAmount.toFixed(2)}) doesn't match what's payable for this settlement (₹${payable.total.toFixed(2)}${payable.gst ? ` — net ₹${payable.net.toFixed(2)} + GST ₹${payable.gst.toFixed(2)}` : ""}). Check the payment ID.`
      });
    }

    await finalizeSettlementPaid(settlement, {
      method: payment.method || "bank_transfer",
      verifiedOnline: true,
      transactionId: payment.id,
      paidAt: payment.created_at ? new Date(payment.created_at * 1000) : new Date(),
      payableTotal: payable.total,
      byUserId: req.adminUser._id,
      req
    });

    return res.json({ success: true, message: "Settlement marked paid.", data: settlement });
  } catch (error) {
    if (error instanceof RazorpayLookupError || error instanceof RazorpayXError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error("markSettlementPaid error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Something went wrong marking the settlement paid." });
  }
};

/* Mirrors partnerSettlementController.getSettlementDetail, just not scoped
   to a single partner — admin can open any settlement's breakdown. */
const getSettlementDetail = async (req, res) => {
  const settlement = await PartnerSettlement.findById(req.params.id)
    .populate("partnerId", "partnerCode legalEntity.businessName")
    .populate({
      path: "commissionIds",
      select: "transaction.invoiceNumber transaction.revenue transaction.currency calculation.commissionType calculation.rate calculation.fixedAmount calculation.grossCommission calculation.deductions calculation.netCommission createdAt"
    })
    .lean();

  if (!settlement) {
    return res.status(404).json({ success: false, message: "Settlement not found." });
  }

  const bankAccount = await PartnerBankAccount.findOne(
    { partnerId: settlement.partnerId?._id || settlement.partnerId },
    "bankName accountNumberLast4 ifscMasked"
  ).lean();

  return res.json({ success: true, data: { ...settlement, bankAccount: bankAccount || null } });
};

// Manual hold — compliance review, or any ad hoc reason an admin needs to
// pause a batch for. Not allowed once it's already paid/cancelled/on_hold.
const holdSettlement = async (req, res) => {
  try {
    const { reason, code } = req.body;
    const settlement = await PartnerSettlement.findById(req.params.id);

    if (!settlement) {
      return res.status(404).json({ success: false, message: "Settlement not found." });
    }

    if (["paid", "cancelled", "on_hold"].includes(settlement.status)) {
      return res.status(400).json({ success: false, message: `Settlement is already ${settlement.status}.` });
    }

    await putSettlementOnHold(settlement, { code, reason, byUserId: req.adminUser._id, req });

    return res.json({ success: true, message: "Settlement put on hold.", data: settlement });
  } catch (error) {
    console.error("holdSettlement error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong holding the settlement." });
  }
};

// Releases a hold back to whatever status it was in before — but only once
// the underlying cause is actually gone (see utils/settlementHold.js).
const releaseSettlement = async (req, res) => {
  try {
    const settlement = await PartnerSettlement.findById(req.params.id);

    if (!settlement) {
      return res.status(404).json({ success: false, message: "Settlement not found." });
    }

    if (settlement.status !== "on_hold") {
      return res.status(400).json({ success: false, message: "Settlement is not on hold." });
    }

    await releaseSettlementHold(settlement, { byUserId: req.adminUser._id, req });

    return res.json({ success: true, message: "Settlement hold released.", data: settlement });
  } catch (error) {
    if (error instanceof HoldReleaseError) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error("releaseSettlement error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong releasing the hold." });
  }
};

// The payout was actually attempted (settlement was approved) and the bank
// transfer itself was rejected — a distinct terminal state from on_hold,
// which is for payouts that were never attempted in the first place.
const failSettlement = async (req, res) => {
  try {
    const { reason } = req.body;
    const settlement = await PartnerSettlement.findById(req.params.id);

    if (!settlement) {
      return res.status(404).json({ success: false, message: "Settlement not found." });
    }

    if (settlement.status !== "approved") {
      return res.status(400).json({ success: false, message: "Only an approved settlement (payout in progress) can be marked failed." });
    }

    settlement.status = "failed";
    settlement.failureReason = reason || "Payout could not be processed.";
    await settlement.save();

    await recordSettlementHistory(settlement, {
      action: "failed",
      fromStatus: "approved",
      toStatus: "failed",
      reason: settlement.failureReason,
      byUserId: req.adminUser._id,
      req
    });

    await logActivity({
      partnerId: settlement.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "settlement_failed",
      entityType: "PartnerSettlement",
      entityId: settlement._id,
      description: `${req.adminUser.name} marked settlement ${settlement.settlementNumber} as failed: ${settlement.failureReason}`,
      req
    });

    await PartnerNotification.create({
      partnerId: settlement.partnerId,
      type: "settlement_failed",
      title: "Payout failed",
      message: `Your settlement ${settlement.settlementNumber} payout failed: ${settlement.failureReason}`,
      entity: { type: "PartnerSettlement", entityId: settlement._id }
    });

    return res.json({ success: true, message: "Settlement marked failed.", data: settlement });
  } catch (error) {
    console.error("failSettlement error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong marking the settlement failed." });
  }
};

// Admin resolved whatever broke the payout — move it back to approved so
// "Mark Paid" can be retried. If the underlying cause is still unresolved
// (e.g. bank still unverified), it lands on hold instead of silently
// failing again.
const retrySettlement = async (req, res) => {
  try {
    const settlement = await PartnerSettlement.findById(req.params.id);

    if (!settlement) {
      return res.status(404).json({ success: false, message: "Settlement not found." });
    }

    if (settlement.status !== "failed") {
      return res.status(400).json({ success: false, message: "Only a failed settlement can be retried." });
    }

    settlement.failureReason = "";

    const eligibility = await checkSettlementPayoutReadiness(settlement);
    if (!eligibility.eligible) {
      settlement.status = "approved";
      await putSettlementOnHold(settlement, { code: eligibility.code, reason: eligibility.reason, byUserId: req.adminUser._id, req });
      return res.json({ success: true, message: `Payout still blocked — settlement placed on hold: ${eligibility.reason}`, data: settlement });
    }

    settlement.status = "approved";
    await settlement.save();

    await recordSettlementHistory(settlement, {
      action: "retried",
      fromStatus: "failed",
      toStatus: "approved",
      byUserId: req.adminUser._id,
      req
    });

    await logActivity({
      partnerId: settlement.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "settlement_retried",
      entityType: "PartnerSettlement",
      entityId: settlement._id,
      description: `${req.adminUser.name} moved settlement ${settlement.settlementNumber} back to approved for a payout retry.`,
      req
    });

    await notifyPartner({
      partnerId: settlement.partnerId,
      type: "settlement_retried",
      title: "Settlement payout is being retried",
      message: `Settlement ${settlement.settlementNumber} is back in the queue — SPOTX will retry the payout.`,
      entityType: "PartnerSettlement",
      entityId: settlement._id
    });

    return res.json({ success: true, message: "Settlement moved back to approved — ready to retry payout.", data: settlement });
  } catch (error) {
    console.error("retrySettlement error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong retrying the settlement." });
  }
};

const getSettlementHistoryAsAdmin = async (req, res) => {
  const history = await getSettlementHistory(req.params.id);
  return res.json({ success: true, data: history });
};

const getBillForSettlementAsAdmin = async (req, res) => {
  const bill = await PartnerSettlementBill.findOne({ settlementId: req.params.id });
  return res.json({ success: true, data: bill || null });
};

const downloadBillAsAdmin = async (req, res) => {
  try {
    const bill = await PartnerSettlementBill.findOne({ settlementId: req.params.id });
    if (!bill) {
      return res.status(404).json({ success: false, message: "No bill has been submitted for this settlement." });
    }

    if (!(await sendStoredFile(res, bill.file))) {
      return res.status(404).json({ success: false, message: "File not found on server." });
    }

    return undefined;
  } catch (error) {
    console.error("downloadBillAsAdmin error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong downloading the bill." });
  }
};

// Verifying/rejecting is scoped to exactly this one settlement's bill —
// deliberately does NOT do a blanket sweep of every "incomplete_info"
// hold for the partner, since a different settlement could be on hold
// with that same code for an unrelated reason (still no bank account, or
// its own bill still unverified). Only re-checks and, if now eligible,
// releases the ONE settlement this bill belongs to.
const verifyBill = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;

    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be 'verified' or 'rejected'." });
    }

    const bill = await PartnerSettlementBill.findOne({ settlementId: req.params.id });
    if (!bill) {
      return res.status(404).json({ success: false, message: "No bill has been submitted for this settlement." });
    }

    if (bill.status !== "submitted") {
      return res.status(400).json({ success: false, message: `This bill has already been ${bill.status}.` });
    }

    bill.status = status;
    bill.verifiedBy = req.adminUser._id;
    bill.verifiedAt = new Date();
    bill.rejectionReason = status === "rejected" ? (rejectionReason || "Rejected.") : "";
    await bill.save();

    await recordSettlementHistory({ _id: bill.settlementId, partnerId: bill.partnerId }, {
      action: status === "verified" ? "bill_verified" : "bill_rejected",
      reason: status === "rejected" ? bill.rejectionReason : "",
      meta: { billNumber: bill.billNumber, gstAmount: bill.amount.gstAmount },
      byUserId: req.adminUser._id,
      req
    });

    await logActivity({
      partnerId: bill.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      // "document_verified" regardless of verified/rejected outcome — same
      // convention adminDocumentController.verifyDocument uses; the enum
      // (a model, can't be extended) has no bill-specific value.
      activityType: "document_verified",
      entityType: "PartnerSettlement",
      entityId: bill.settlementId,
      description: `${req.adminUser.name} ${status} the bill (${bill.billNumber}) for this settlement.`,
      req
    });

    await PartnerNotification.create({
      partnerId: bill.partnerId,
      type: status === "verified" ? "settlement_bill_verified" : "settlement_bill_rejected",
      title: status === "verified" ? "Bill verified" : "Bill rejected",
      message: status === "verified"
        ? `Your bill ${bill.billNumber} was verified.`
        : `Your bill ${bill.billNumber} was rejected: ${bill.rejectionReason}`,
      entity: { type: "PartnerSettlement", entityId: bill.settlementId }
    }).catch((error) => console.error("verifyBill: notification failed:", error.message));

    let settlement = null;
    if (status === "verified") {
      settlement = await PartnerSettlement.findById(bill.settlementId);
      if (settlement && settlement.status === "on_hold" && settlement.hold?.code === "incomplete_info") {
        const readiness = await checkSettlementPayoutReadiness(settlement);
        if (readiness.eligible) {
          await releaseSettlementHold(settlement, { byUserId: req.adminUser._id, req }).catch((error) =>
            console.error("verifyBill: auto-release failed:", error.message)
          );
        }
      }
    }

    return res.json({ success: true, message: `Bill ${status}.`, data: { bill, settlement } });
  } catch (error) {
    console.error("verifyBill error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong verifying the bill." });
  }
};

module.exports = {
  listSettlements,
  createSettlement,
  approveSettlement,
  markSettlementPaid,
  markSettlementPaidOffline,
  getSettlementDetail,
  holdSettlement,
  releaseSettlement,
  failSettlement,
  retrySettlement,
  fetchRazorpayPayment, getPayoutDetails, checkOnlinePayout,
  getBillForSettlementAsAdmin,
  downloadBillAsAdmin,
  verifyBill,
  getSettlementHistoryAsAdmin
};
