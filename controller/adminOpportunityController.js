const { PartnerOpportunity, PartnerReferral, Partner } = require("../models/Index");
const { generateCommissionForWonOpportunity } = require("../services/commissionEngine");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");

/* ============================================================
   ADMIN — OPPORTUNITY PIPELINE
============================================================ */

const listOpportunities = async (req, res) => {
  const { stage, partnerId } = req.query;

  const filter = {};
  if (stage) filter.stage = stage;
  if (partnerId) filter.partnerId = partnerId;

  const opportunities = await PartnerOpportunity.find(filter)
    .sort({ createdAt: -1 })
    .populate("partnerId", "partnerCode legalEntity.businessName");

  return res.json({ success: true, data: opportunities });
};

const updateStage = async (req, res) => {
  try {
    const { stage } = req.body;
    const validStages = ["qualification", "demo", "proposal", "negotiation", "won", "lost"];

    if (!validStages.includes(stage)) {
      return res.status(400).json({ success: false, message: "Invalid stage." });
    }

    const opportunity = await PartnerOpportunity.findById(req.params.id);

    if (!opportunity) {
      return res.status(404).json({ success: false, message: "Opportunity not found." });
    }

    opportunity.stage = stage;
    await opportunity.save();

    await notifyPartner({
      partnerId: opportunity.partnerId,
      type: "opportunity_stage_changed",
      title: "Your deal moved forward",
      message: `${opportunity.customer?.companyName || "Your deal"} is now at the ${stage} stage.`,
      entityType: "PartnerOpportunity",
      entityId: opportunity._id
    });

    return res.json({ success: true, message: "Stage updated.", data: opportunity });
  } catch (error) {
    console.error("updateStage error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong updating the stage." });
  }
};

/* Marks won and triggers the commission engine */
const markWon = async (req, res) => {
  try {
    const { revenue, screenCount, applyAddOn } = req.body;

    if (!revenue || revenue <= 0) {
      return res.status(400).json({ success: false, message: "A positive revenue amount is required to mark a deal won." });
    }

    const opportunity = await PartnerOpportunity.findById(req.params.id);

    if (!opportunity) {
      return res.status(404).json({ success: false, message: "Opportunity not found." });
    }

    if (opportunity.result.status === "won") {
      return res.status(400).json({ success: false, message: "This opportunity is already marked won." });
    }

    opportunity.stage = "won";
    opportunity.result.status = "won";
    opportunity.result.wonAt = new Date();
    await opportunity.save();

    if (opportunity.referralId) {
      await PartnerReferral.findByIdAndUpdate(opportunity.referralId, { status: "won" });
    }

    const { commission, addOnCommission } = await generateCommissionForWonOpportunity({
      opportunity,
      revenue,
      screenCount: screenCount || 0,
      applyAddOn: Boolean(applyAddOn),
      req,
      adminUser: req.adminUser
    });

    await logActivity({
      partnerId: opportunity.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "deal_won",
      entityType: "PartnerOpportunity",
      entityId: opportunity._id,
      description: `${req.adminUser.name} marked the deal won.`,
      req
    });

    return res.json({
      success: true,
      message: "Deal marked won and commission generated.",
      data: { opportunity, commission, addOnCommission }
    });
  } catch (error) {
    console.error("markWon error:", error);
    return res.status(400).json({ success: false, message: error.message || "Something went wrong marking the deal won." });
  }
};

const markLost = async (req, res) => {
  try {
    const { lostReason } = req.body;

    const opportunity = await PartnerOpportunity.findById(req.params.id);

    if (!opportunity) {
      return res.status(404).json({ success: false, message: "Opportunity not found." });
    }

    opportunity.stage = "lost";
    opportunity.result.status = "lost";
    opportunity.result.lostReason = lostReason || "";
    await opportunity.save();

    if (opportunity.referralId) {
      await PartnerReferral.findByIdAndUpdate(opportunity.referralId, { status: "lost" });
    }

    await logActivity({
      partnerId: opportunity.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "deal_lost",
      entityType: "PartnerOpportunity",
      entityId: opportunity._id,
      description: `${req.adminUser.name} marked the deal lost.`,
      req
    });

    await notifyPartner({
      partnerId: opportunity.partnerId,
      type: "opportunity_lost",
      title: "A deal was lost",
      message: `${opportunity.customer?.companyName || "Your deal"} was marked lost${lostReason ? `: ${lostReason}` : "."}`,
      entityType: "PartnerOpportunity",
      entityId: opportunity._id
    });

    return res.json({ success: true, message: "Deal marked lost.", data: opportunity });
  } catch (error) {
    console.error("markLost error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong marking the deal lost." });
  }
};

module.exports = { listOpportunities, updateStage, markWon, markLost };
