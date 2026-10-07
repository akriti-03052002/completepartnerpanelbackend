const mongoose = require("mongoose");
const { PartnerProgram, PartnerTier, CommissionRule, SettlementSetting, ScreenPricing } = require("../models/Index");
const { getMaskedSettings, updateSettings } = require("../utils/paymentGatewayConfig");

/* ============================================================
   ADMIN — PROGRAM / TIER / COMMISSION RULE / SETTLEMENT SETTING
   Plain CRUD for the four configuration resources. Grouped in
   one file since each is a small, near-identical pattern.
============================================================ */

/**
 * Only Vendor (recurring % of subscription per screen) has an
 * unambiguous commissionType — everything else's "one-time" fee could
 * be a flat amount or a percentage, so we don't guess: the admin
 * creates that rule manually via the Commission Rules tab instead.
 *
 * Reseller is deliberately excluded here, not just unhandled: a
 * Reseller partner never earns a commission at all — they purchase
 * software licenses from SPOTX wholesale and are billed for it (see
 * ResellerPricingPlan / ResellerInvoice), the reverse of every other
 * partner type. No CommissionRule is ever auto-generated, or should
 * ever be manually created, for partnerType "reseller".
 */
const buildAutoRuleShape = (tier, rate) => {
  if (tier.partnerType === "vendor") {
    return {
      name: `${tier.name} — ${rate}% recurring`,
      commissionType: "recurring_percentage",
      rate,
      calculationBase: "subscription_value",
      recurring: { enabled: true, durationType: "lifetime" }
    };
  }

  return null;
};

// ---- Programs ----

const listPrograms = async (req, res) => {
  const programs = await PartnerProgram.find().sort({ createdAt: -1 });
  return res.json({ success: true, data: programs });
};

const createProgram = async (req, res) => {
  try {
    const program = await PartnerProgram.create(req.body);
    return res.status(201).json({ success: true, message: "Program created.", data: program });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

const updateProgram = async (req, res) => {
  const program = await PartnerProgram.findByIdAndUpdate(req.params.id, req.body, { returnDocument: "after", runValidators: true });
  if (!program) return res.status(404).json({ success: false, message: "Program not found." });
  return res.json({ success: true, message: "Program updated.", data: program });
};

// ---- Tiers ----

const listTiers = async (req, res) => {
  const filter = {};
  if (req.query.programId) filter.programId = req.query.programId;
  if (req.query.partnerType) filter.partnerType = req.query.partnerType;

  const tiers = await PartnerTier.find(filter).sort({ level: 1 });
  return res.json({ success: true, data: tiers });
};

const createTier = async (req, res) => {
  try {
    if (!req.body.partnerType) {
      return res.status(400).json({ success: false, message: "partnerType is required." });
    }

    const tier = await PartnerTier.create(req.body);

    // Keep the tier's displayed rate and the commission engine in sync —
    // without this, a tier could show "20%" while deals still fall back
    // to a generic rule because no CommissionRule actually references it.
    const rate = tier.benefits?.commissionRate;
    const ruleShape = rate ? buildAutoRuleShape(tier, rate) : null;

    if (ruleShape) {
      await CommissionRule.create({ tierId: tier._id, partnerType: tier.partnerType, status: "active", ...ruleShape });
    }

    return res.status(201).json({ success: true, message: "Tier created.", data: tier });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

const updateTier = async (req, res) => {
  const tier = await PartnerTier.findByIdAndUpdate(req.params.id, req.body, { returnDocument: "after", runValidators: true });
  if (!tier) return res.status(404).json({ success: false, message: "Tier not found." });

  const rate = tier.benefits?.commissionRate;
  const ruleShape = rate ? buildAutoRuleShape(tier, rate) : null;

  if (ruleShape) {
    // Update the matching auto-managed rule if one exists, otherwise
    // create it — same sync guarantee as createTier.
    const existingRule = await CommissionRule.findOne({ tierId: tier._id, commissionType: ruleShape.commissionType });

    if (existingRule) {
      Object.assign(existingRule, ruleShape);
      await existingRule.save();
    } else {
      await CommissionRule.create({ tierId: tier._id, partnerType: tier.partnerType, status: "active", ...ruleShape });
    }
  }

  return res.json({ success: true, message: "Tier updated.", data: tier });
};

// ---- Commission Rules ----

const listCommissionRules = async (req, res) => {
  const filter = {};
  if (req.query.partnerType) filter.partnerType = req.query.partnerType;
  if (req.query.isAddOn !== undefined) filter.isAddOn = req.query.isAddOn === "true";

  const rules = await CommissionRule.find(filter).sort({ createdAt: -1 });
  return res.json({ success: true, data: rules });
};

const createCommissionRule = async (req, res) => {
  try {
    const rule = await CommissionRule.create(req.body);
    return res.status(201).json({ success: true, message: "Commission rule created.", data: rule });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

const updateCommissionRule = async (req, res) => {
  const rule = await CommissionRule.findByIdAndUpdate(req.params.id, req.body, { returnDocument: "after", runValidators: true });
  if (!rule) return res.status(404).json({ success: false, message: "Commission rule not found." });
  return res.json({ success: true, message: "Commission rule updated.", data: rule });
};

// ---- Settlement Settings ----

const listSettlementSettings = async (req, res) => {
  // ?partnerId= narrows to one partner's schedule (the admin partner page).
  const filter = {};
  if (req.query.partnerId) {
    if (!mongoose.isValidObjectId(req.query.partnerId)) return res.json({ success: true, data: [] });
    filter.partnerId = req.query.partnerId;
  }
  const settings = await SettlementSetting.find(filter).populate("partnerId", "partnerCode legalEntity.businessName");
  return res.json({ success: true, data: settings });
};

const upsertSettlementSetting = async (req, res) => {
  try {
    const { partnerId, ...rest } = req.body;

    if (!partnerId) {
      return res.status(400).json({ success: false, message: "partnerId is required." });
    }

    const setting = await SettlementSetting.findOneAndUpdate(
      { partnerId },
      { $set: rest, $setOnInsert: { partnerId } },
      { returnDocument: "after", upsert: true, runValidators: true }
    );

    const warning = await require("../services/refreshExistingAgreement")(partnerId, req.adminUser._id);
    return res.json({ success: true, message: warning || "Payment settings saved. Any existing agreement has been updated.", data: setting });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ---- Screen Pricing (global Basic / Premium price-per-screen plans) ----

const getScreenPricing = async (req, res) => {
  let pricing = await ScreenPricing.findOne();
  if (!pricing) pricing = await ScreenPricing.create({});
  return res.json({ success: true, data: pricing });
};

const updateScreenPricing = async (req, res) => {
  try {
    const { basicPricePerScreen, premiumPricePerScreen } = req.body;

    if (Number(basicPricePerScreen) < 0 || Number(premiumPricePerScreen) < 0) {
      return res.status(400).json({ success: false, message: "Valid prices are required for both plans." });
    }

    const existing = await ScreenPricing.findOne();
    const update = { basicPricePerScreen, premiumPricePerScreen };
    const pricing = existing
      ? await ScreenPricing.findByIdAndUpdate(existing._id, update, { returnDocument: "after", runValidators: true })
      : await ScreenPricing.create(update);

    return res.json({ success: true, message: "Screen pricing updated.", data: pricing });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// ---- Payment Gateway (Razorpay credentials) ----
// Never returns a decrypted secret — see utils/paymentGatewayConfig for
// exactly what's exposed vs kept write-only.

const getPaymentGatewaySettings = async (req, res) => {
  const settings = await getMaskedSettings();
  return res.json({ success: true, data: settings });
};

const updatePaymentGatewaySettings = async (req, res) => {
  try {
    const { razorpay } = req.body;
    await updateSettings({ razorpay }, req.adminUser._id);
    const settings = await getMaskedSettings();
    return res.json({ success: true, message: "Payment gateway settings saved.", data: settings });
  } catch (error) {
    console.error("updatePaymentGatewaySettings error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong saving these settings." });
  }
};

module.exports = {
  listPrograms, createProgram, updateProgram,
  listTiers, createTier, updateTier,
  listCommissionRules, createCommissionRule, updateCommissionRule,
  listSettlementSettings, upsertSettlementSetting,
  getScreenPricing, updateScreenPricing,
  getPaymentGatewaySettings, updatePaymentGatewaySettings
};
