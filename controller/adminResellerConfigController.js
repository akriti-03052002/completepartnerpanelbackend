const ResellerPricingPlan = require("../models/ResellerPricingPlan");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");
const Partner = require("../models/Partner");
const { PartnerNotification } = require("../models/Index");
const { getOrCreatePricingPlan } = require("../services/resellerPricing");
const { regeneratePartnerAgreement } = require("../services/generatePartnerAgreement");
const { fetchPaymentById } = require("../utils/razorpay");
const { claimPayment } = require("../utils/assertPaymentNotReused");
const logActivity = require("../utils/logActivity");
const asyncHandler = require("express-async-handler");

// Re-renders the Partner Agreement PDF (which embeds live pricing/billing
// terms) after an admin changes pricing or billing config, and notifies the
// partner. Mirrors logActivity's contract: a failure here (PDF glitch, disk
// issue) must never fail the config-save request that triggered it — it's
// a side effect of the save, not part of it, so we log and swallow.
const regenerateAgreementAndNotify = async (partner, adminUserId, changeSummary) => {
  try {
    const doc = await regeneratePartnerAgreement(partner, adminUserId);
    await PartnerNotification.create({
      partnerId: partner._id,
      type: "agreement_updated",
      title: "Your partner agreement has been updated",
      message: `Your Partner Agreement was reissued to reflect updated terms: ${changeSummary}.`,
      entity: { type: "PartnerDocument", entityId: doc._id }
    });
  } catch (error) {
    console.error("Failed to regenerate partner agreement after config change:", error.message);
  }
};

/* ============================================================
   ADMIN — RESELLER PRICING & BILLING CONFIG
   Superadmin-only, per partner. A Reseller partner can never edit
   any of this from the partner panel — pricingMode, rate, and
   billingCycle are all set here, per the partner's signed
   agreement.
============================================================ */

const getPricingPlan = asyncHandler(async (req, res) => {
  const partner = await Partner.findById(req.params.id);
  if (!partner || partner.partnerType !== "reseller") {
    return res.status(404).json({ success: false, message: "Reseller partner not found." });
  }

  const plan = await getOrCreatePricingPlan(partner._id);
  return res.json({ success: true, data: plan });
});

const updatePricingPlan = asyncHandler(async (req, res) => {
  const partner = await Partner.findById(req.params.id);
  if (!partner || partner.partnerType !== "reseller") {
    return res.status(404).json({ success: false, message: "Reseller partner not found." });
  }

  const {
    standardPricePerScreen, pricingMode, wholesaleDiscountPercent, fixedPricePerScreen,
    minPurchaseQty, bulkTiers, bulkTierBasis, taxRatePercent
  } = req.body;

  if (pricingMode && !["discount_percent", "fixed_price"].includes(pricingMode)) {
    return res.status(400).json({ success: false, message: "Invalid pricing mode." });
  }

  let plan = await ResellerPricingPlan.findOne({ partnerId: partner._id });
  if (!plan) plan = new ResellerPricingPlan({ partnerId: partner._id });

  if (standardPricePerScreen !== undefined) plan.standardPricePerScreen = standardPricePerScreen;
  if (pricingMode !== undefined) plan.pricingMode = pricingMode;
  if (wholesaleDiscountPercent !== undefined) plan.wholesaleDiscountPercent = wholesaleDiscountPercent;
  if (fixedPricePerScreen !== undefined) plan.fixedPricePerScreen = fixedPricePerScreen;
  if (minPurchaseQty !== undefined) plan.minPurchaseQty = minPurchaseQty;
  if (bulkTiers !== undefined) plan.bulkTiers = bulkTiers;
  if (bulkTierBasis !== undefined) plan.bulkTierBasis = bulkTierBasis;
  if (taxRatePercent !== undefined) plan.taxRatePercent = taxRatePercent;

  // effectivePricePerScreen is recomputed by the model's pre-save hook,
  // but we save explicitly here to run it before responding.
  await plan.save();

  await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "ResellerPricingPlan",
      entityId: plan._id,
      description: `Pricing plan updated — ${plan.pricingMode} mode, effective rate ${plan.effectivePricePerScreen}/screen.`,
      req
    });

  await regenerateAgreementAndNotify(
    partner,
    req.adminUser._id,
    `pricing plan (${plan.pricingMode === "fixed_price" ? "fixed price" : "discount"} — effective rate Rs. ${plan.effectivePricePerScreen}/screen)`
  );

  return res.json({ success: true, message: "Pricing plan updated.", data: plan });
});

const getBillingConfig = asyncHandler(async (req, res) => {
  const partner = await Partner.findById(req.params.id);
  if (!partner || partner.partnerType !== "reseller") {
    return res.status(404).json({ success: false, message: "Reseller partner not found." });
  }

  let config = await ResellerBillingConfig.findOne({ partnerId: partner._id });
  if (!config) config = await ResellerBillingConfig.create({ partnerId: partner._id });

  return res.json({ success: true, data: config });
});

const updateBillingConfig = asyncHandler(async (req, res) => {
  const partner = await Partner.findById(req.params.id);
  if (!partner || partner.partnerType !== "reseller") {
    return res.status(404).json({ success: false, message: "Reseller partner not found." });
  }

  const {
    billingCycle, billingStartRule, prorationRule, dueDays,
    dueDateReminderDaysBefore, lowInventoryNotificationThresholdPercent,
    retrySchedule, gracePeriodDays, agreementEndDate
  } = req.body;

  let config = await ResellerBillingConfig.findOne({ partnerId: partner._id });
  if (!config) config = await ResellerBillingConfig.create({ partnerId: partner._id });

  if (billingCycle !== undefined) config.billingCycle = billingCycle;
  if (billingStartRule !== undefined) config.billingStartRule = billingStartRule;
  if (prorationRule !== undefined) config.prorationRule = prorationRule;
  if (dueDays !== undefined) config.dueDays = dueDays;
  if (dueDateReminderDaysBefore !== undefined) config.dueDateReminderDaysBefore = dueDateReminderDaysBefore;
  if (lowInventoryNotificationThresholdPercent !== undefined) config.lowInventoryNotificationThresholdPercent = lowInventoryNotificationThresholdPercent;
  if (retrySchedule !== undefined) config.retrySchedule = retrySchedule;
  if (gracePeriodDays !== undefined) config.gracePeriodDays = gracePeriodDays;
  if (agreementEndDate !== undefined) config.agreementEndDate = agreementEndDate;

  await config.save();

  await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "ResellerBillingConfig",
      entityId: config._id,
      description: `Billing config updated — cycle: ${config.billingCycle}.`,
      req
    });

  await regenerateAgreementAndNotify(partner, req.adminUser._id, `billing configuration (billing cycle: ${config.billingCycle})`);

  return res.json({ success: true, message: "Billing config updated.", data: config });
});

// Admin sets the one-time prepayment amount and how it'll be paid. Online
// just opens it up for the reseller to pay themselves (status ->
// awaiting_payment); offline means the admin already has a transaction
// reference and it's checked against Razorpay right here, in one step
// (status -> done immediately if it checks out) — same online/offline
// split as adminLicenseOrderController.changePaymentMode.
const setPrepayment = asyncHandler(async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner || partner.partnerType !== "reseller") {
      return res.status(404).json({ success: false, message: "Reseller partner not found." });
    }

    const { paymentMode, amount, transactionId, method = "razorpay" } = req.body;

    if (!["online", "offline"].includes(paymentMode)) {
      return res.status(400).json({ success: false, message: "paymentMode must be 'online' or 'offline'." });
    }

    const numericAmount = Number(amount);
    if (!numericAmount || numericAmount <= 0) {
      return res.status(400).json({ success: false, message: "Enter a valid prepayment amount." });
    }

    let config = await ResellerBillingConfig.findOne({ partnerId: partner._id });
    if (!config) config = await ResellerBillingConfig.create({ partnerId: partner._id });

    if (config.prepayment?.status === "done") {
      return res.status(400).json({ success: false, message: "Prepayment is already done for this partner — it's one-time only." });
    }

    if (paymentMode === "online") {
      config = await ResellerBillingConfig.findOneAndUpdate(
        { _id: config._id, "prepayment.status": { $ne: "done" } },
        { $set: { "prepayment.status": "awaiting_payment", "prepayment.paymentMode": "online", "prepayment.amount": numericAmount, "prepayment.currency": "INR", "prepayment.setBy": req.adminUser._id, "prepayment.setAt": new Date() },
          $unset: { "prepayment.razorpay": 1 } },
        { returnDocument: "after", runValidators: true }
      );
      if (!config) return res.status(409).json({ success: false, message: "Prepayment was already completed." });


      await PartnerNotification.create({
        partnerId: partner._id,
        type: "prepayment_awaiting_payment",
        title: "One-time prepayment required",
        message: `Pay your one-time prepayment of ₹${numericAmount.toLocaleString("en-IN")} from your Billing page to unlock buying licenses.`,
        entity: { type: "ResellerBillingConfig", entityId: config._id }
      });

      await logActivity({
        partnerId: partner._id,
        performedByType: "spotx_user",
        performedByUserId: req.adminUser._id,
        activityType: "note",
        entityType: "ResellerBillingConfig",
        entityId: config._id,
        description: `${req.adminUser.name} set a ₹${numericAmount} online prepayment — awaiting reseller payment.`,
        req
      });

      await regenerateAgreementAndNotify(partner, req.adminUser._id, `one-time prepayment of Rs. ${numericAmount} (awaiting payment)`);

      return res.json({ success: true, message: "Prepayment set — reseller can now pay it from their panel.", data: config });
    }

    // Offline — admin already has a reference, verify it against Razorpay now.
    if (!["razorpay", "cheque", "cash"].includes(method)) {
      return res.status(400).json({ success: false, message: "Invalid offline payment method." });
    }
    if (typeof transactionId !== "string" || !transactionId.trim()) {
      return res.status(400).json({ success: false, message: "Enter a payment ID, cheque number or cash receipt number." });
    }

    const chequeStatus = req.body.chequeStatus || "cleared";
    if (method === "cheque" && !["received", "cleared", "bounced"].includes(chequeStatus)) return res.status(400).json({ success: false, message: "Invalid cheque status." });
    if (method === "cheque" && chequeStatus !== "cleared") {
      const updated = await ResellerBillingConfig.findOneAndUpdate(
        { _id: config._id, "prepayment.status": { $ne: "done" } },
        { $set: { "prepayment.status": "not_done", "prepayment.paymentMode": "offline", "prepayment.amount": numericAmount, "prepayment.cheque": { number: transactionId.trim(), status: chequeStatus, updatedAt: new Date(), updatedBy: req.adminUser._id } },
          $push: { "prepayment.paymentHistory": { action: `cheque_${chequeStatus}`, method, reference: transactionId.trim(), amount: numericAmount, recordedAt: new Date(), recordedBy: req.adminUser._id } } },
        { returnDocument: "after", runValidators: true }
      );
      if (!updated) return res.status(409).json({ success: false, message: "Prepayment was already processed." });
      return res.json({ success: true, message: `Cheque ${chequeStatus} recorded. License purchases stay locked until payment clears.`, data: updated });
    }

    let payment;
    if (method === "razorpay") {
      payment = await fetchPaymentById(transactionId.trim());

      if (payment.status !== "captured") {
        return res.status(400).json({
          success: false,
          message: `This payment shows as "${payment.status}" on Razorpay, not captured — it can't be verified yet.`
        });
      }

      if (payment.amount !== Math.round(numericAmount * 100)) {
        return res.status(400).json({
          success: false,
          message: `This payment's amount (₹${(payment.amount / 100).toLocaleString("en-IN")}) doesn't match the entered amount (₹${numericAmount.toLocaleString("en-IN")}).`
        });
      }

      await claimPayment(payment.id, `prepayment:${partner._id}`);
    }

    const prepayment = {
      status: "done",
      ...(method === "cheque" ? { cheque: { number: transactionId.trim(), status: "cleared", updatedAt: new Date(), updatedBy: req.adminUser._id } } : config.prepayment?.cheque?.number ? { cheque: JSON.parse(JSON.stringify(config.prepayment.cheque)) } : {}),
      paymentHistory: [...(config.prepayment?.paymentHistory?.map((event) => event.toObject()) || []), { action: "paid", method, reference: transactionId.trim(), amount: numericAmount, recordedAt: new Date(), recordedBy: req.adminUser._id }],
      paymentMode: "offline",
      amount: numericAmount,
      currency: "INR",
      razorpay: payment ? { paymentId: payment.id, method: payment.method } : undefined,
      offlinePayment: { method, transactionId: transactionId.trim() },
      setBy: req.adminUser._id,
      setAt: new Date(),
      paidAt: new Date()
    };
    config = await ResellerBillingConfig.findOneAndUpdate(
      { _id: config._id, "prepayment.status": { $ne: "done" } },
      { $set: { prepayment } },
      { returnDocument: "after", runValidators: true }
    );
    if (!config) return res.status(409).json({ success: false, message: "Prepayment was already processed." });


    await PartnerNotification.create({
      partnerId: partner._id,
      type: "prepayment_done",
      title: "Prepayment verified",
      message: `Your one-time prepayment of ₹${numericAmount.toLocaleString("en-IN")} was verified. You can now buy licenses.`,
      entity: { type: "ResellerBillingConfig", entityId: config._id }
    });

    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "ResellerBillingConfig",
      entityId: config._id,
      description: `${req.adminUser.name} verified a ₹${numericAmount} ${method} prepayment (ref: ${transactionId.trim()}) — license purchases unlocked.`,
      req
    });

    await regenerateAgreementAndNotify(partner, req.adminUser._id, `one-time prepayment of Rs. ${numericAmount} (verified/paid)`);

    return res.json({ success: true, message: "Prepayment verified — the reseller can now buy licenses.", data: config });
  } catch (error) {
    console.error("setPrepayment error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Something went wrong setting the prepayment." });
  }
});

module.exports = { getPricingPlan, updatePricingPlan, getBillingConfig, updateBillingConfig, setPrepayment };
