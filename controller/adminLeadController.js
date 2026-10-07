const pagination = require("../utils/pagination");
const mongoose = require("mongoose");
const {
  Partner,
  PartnerReferral,
  PartnerCommission,
  PartnerBankAccount,
  PartnerNotification,
  ScreenPricing
} = require("../models/Index");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");

const OPEN_STATUSES = ["new", "contacted"];
const LEAD_STATUSES = ["new", "contacted", "qualified", "demo_scheduled", "demo_completed", "proposal", "won", "lost", "rejected"];

const getPlanPrices = async () => {
  const pricing = await ScreenPricing.findOne().lean();
  const defaultPrice = (field) => ScreenPricing.schema.path(field).defaultValue;
  return {
    basic: pricing?.basicPricePerScreen ?? defaultPrice("basicPricePerScreen"),
    premium: pricing?.premiumPricePerScreen ?? defaultPrice("premiumPricePerScreen")
  };
};

const findAffiliateLead = async (id) => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const affiliatePartners = await Partner.distinct("_id", { partnerType: "affiliate" });
  return PartnerReferral.findOne({ _id: id, partnerId: { $in: affiliatePartners } });
};

const listLeads = async (req, res) => {
  const { status, partnerId } = req.query;
  if (status && !LEAD_STATUSES.includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid lead status." });
  }

  const affiliatePartners = await Partner.distinct("_id", { partnerType: "affiliate" });
  const filter = { partnerId: { $in: affiliatePartners } };
  if (status) filter.status = status;
  if (partnerId) filter.partnerId = affiliatePartners.some((id) => String(id) === partnerId) ? partnerId : { $in: [] };

  const { page, limit, skip } = pagination(req.query);
  const [leads, planPrices, total, summaryRows] = await Promise.all([
    PartnerReferral.find(filter)
      .sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit)
      .populate("partnerId", "partnerCode legalEntity.businessName primaryContact.name")
      .lean(),
    getPlanPrices(),
    PartnerReferral.countDocuments(filter),
    PartnerReferral.aggregate([
      { $match: { partnerId: typeof filter.partnerId === "string" ? new mongoose.Types.ObjectId(filter.partnerId) : filter.partnerId } },
      { $group: { _id: "$status", count: { $sum: 1 }, value: { $sum: "$closure.dealValue" } } }
    ])
  ]);

  return res.json({
    success: true,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    summary: Object.fromEntries(summaryRows.map((row) => [row._id, { count: row.count, value: row.value }])),
    planPrices,
    pricePerScreen: planPrices.basic,
    data: leads.map((lead) => ({
      ...lead,
      estimatedValue: (lead.requirement?.screenCount || 0) * planPrices.basic
    }))
  });
};

const markContacted = async (req, res) => {
  const lead = await findAffiliateLead(req.params.id);
  if (!lead) return res.status(404).json({ success: false, message: "Lead not found." });
  if (lead.status !== "new") {
    return res.status(400).json({ success: false, message: `Lead is already ${lead.status}.` });
  }

  lead.status = "contacted";
  await lead.save();
  await logActivity({
    partnerId: lead.partnerId,
    performedByType: "spotx_user",
    performedByUserId: req.adminUser._id,
    activityType: "lead_updated",
    entityType: "PartnerReferral",
    entityId: lead._id,
    description: `${req.adminUser.name} contacted ${lead.customer.companyName}.`,
    req
  });
  await notifyPartner({
    partnerId: lead.partnerId,
    type: "lead_contacted",
    title: "SPOTX contacted your lead",
    message: `SPOTX has reached out to ${lead.customer.companyName}. You'll be notified when the deal is won or closed.`,
    entityType: "PartnerReferral",
    entityId: lead._id
  });

  return res.json({ success: true, message: "Lead marked contacted.", data: lead });
};

const markWon = async (req, res) => {
  const { plan } = req.body;
  const screenCount = Number(req.body.screenCount);
  const commissionAmount = Number(req.body.commissionAmount);
  if (!["basic", "premium"].includes(plan)) {
    return res.status(400).json({ success: false, message: "Choose the Basic or Premium plan." });
  }
  if (!Number.isInteger(screenCount) || screenCount < 1) {
    return res.status(400).json({ success: false, message: "Enter a positive whole number of screens." });
  }
  if (!Number.isFinite(commissionAmount) || commissionAmount <= 0 || commissionAmount > 100000000) {
    return res.status(400).json({ success: false, message: "Referral reward must be between ₹1 and ₹10 crore." });
  }

  const planPrices = await getPlanPrices();
  const pricePerScreen = planPrices[plan];
  const dealValue = screenCount * pricePerScreen;
  if (!(dealValue > 0)) {
    return res.status(400).json({ success: false, message: `The ${plan} plan has no price set.` });
  }

  const session = await mongoose.startSession();
  let lead;
  let commission;
  try {
    await session.withTransaction(async () => {
      const affiliatePartners = await Partner.distinct("_id", { partnerType: "affiliate" }).session(session);
      lead = await PartnerReferral.findOne({
        _id: req.params.id,
        partnerId: { $in: affiliatePartners }
      }).session(session);
      if (!lead) throw Object.assign(new Error("Lead not found."), { statusCode: 404 });
      if (!OPEN_STATUSES.includes(lead.status)) {
        throw Object.assign(new Error(`Lead is already ${lead.status}.`), { statusCode: 400 });
      }

      const partner = await Partner.findOne({ _id: lead.partnerId, partnerType: "affiliate" }).session(session);
      if (!partner) throw Object.assign(new Error("Affiliate partner not found."), { statusCode: 404 });
      const bankAccount = await PartnerBankAccount.findOne({ partnerId: partner._id }).session(session);
      if (!bankAccount || bankAccount.commissionEligibility !== "eligible") {
        throw Object.assign(new Error("This partner's bank account isn't verified and commission-eligible yet."), { statusCode: 400 });
      }

      const [createdCommission] = await PartnerCommission.create([{
        partnerId: partner._id,
        referralId: lead._id,
        description: "Affiliate referral reward",
        transaction: { revenue: dealValue, screenCount, currency: "INR" },
        calculation: {
          commissionType: "fixed_per_deal",
          fixedAmount: commissionAmount,
          grossCommission: commissionAmount,
          deductions: 0,
          netCommission: commissionAmount
        },
        settlement: { status: "pending", eligibleAt: new Date() }
      }], { session });
      commission = createdCommission;

      lead.status = "won";
      lead.closure = {
        plan,
        pricePerScreen,
        dealValue,
        screenCount,
        commissionAmount,
        commissionId: commission._id,
        reason: "",
        closedAt: new Date(),
        closedBy: req.adminUser._id
      };
      await lead.save({ session });

      partner.stats.wonDeals += 1;
      partner.stats.totalRevenue += dealValue;
      partner.stats.totalCommission += commissionAmount;
      partner.stats.pendingCommission += commissionAmount;
      await partner.save({ session });
    });
  } catch (error) {
    console.error("markWon error:", error);
    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.message || "Something went wrong closing the lead."
    });
  } finally {
    await session.endSession();
  }

  await logActivity({
    partnerId: lead.partnerId,
    performedByType: "spotx_user",
    performedByUserId: req.adminUser._id,
    activityType: "deal_won",
    entityType: "PartnerReferral",
    entityId: lead._id,
    description: `${req.adminUser.name} closed ${lead.customer.companyName} as won.`,
    req
  });
  await PartnerNotification.create({
    partnerId: lead.partnerId,
    type: "lead_won",
    title: "Your lead was won — referral reward earned",
    message: `${lead.customer.companyName} became a SPOTX customer. You earned a referral reward of ₹${commissionAmount.toLocaleString("en-IN")}; it will be paid in a settlement once approved.`,
    entity: { type: "PartnerCommission", entityId: commission._id }
  });

  return res.json({
    success: true,
    message: "Lead marked won and referral reward added to the commission ledger.",
    data: { lead, commission }
  });
};

const rejectLead = async (req, res) => {
  const lead = await findAffiliateLead(req.params.id);
  if (!lead) return res.status(404).json({ success: false, message: "Lead not found." });
  if (!OPEN_STATUSES.includes(lead.status)) {
    return res.status(400).json({ success: false, message: `A ${lead.status} lead can't be rejected.` });
  }

  lead.status = "rejected";
  lead.closure = {
    ...(lead.closure?.toObject?.() || {}),
    reason: String(req.body.reason || "").trim(),
    closedAt: new Date(),
    closedBy: req.adminUser._id
  };
  await lead.save();
  await logActivity({
    partnerId: lead.partnerId,
    performedByType: "spotx_user",
    performedByUserId: req.adminUser._id,
    activityType: "lead_updated",
    entityType: "PartnerReferral",
    entityId: lead._id,
    description: `${req.adminUser.name} rejected the referral for ${lead.customer.companyName}.`,
    req
  });
  await notifyPartner({
    partnerId: lead.partnerId,
    type: "lead_rejected",
    title: "Your lead was not taken forward",
    message: lead.closure.reason
      ? `Your referral for ${lead.customer.companyName} was rejected: ${lead.closure.reason}`
      : `Your referral for ${lead.customer.companyName} was rejected.`,
    entityType: "PartnerReferral",
    entityId: lead._id
  });

  return res.json({ success: true, message: "Lead rejected.", data: lead });
};

module.exports = { listLeads, markContacted, markWon, rejectLead };
