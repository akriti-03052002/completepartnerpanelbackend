const { Partner, PartnerReferral, PartnerOpportunity } = require("../models/Index");
const logActivity = require("../utils/logActivity");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;
const notifyPartner = require("../utils/notifyPartner");

/* ============================================================
   PARTNER REFERRALS (LEADS)
============================================================ */

const listReferrals = async (req, res) => {
  // Deal value is SPOTX-internal; the partner only sees their reward.
  const referrals = await PartnerReferral.find({ partnerId: req.partner._id })
    .select("-closure.dealValue -closure.pricePerScreen -closure.closedBy")
    .sort({ createdAt: -1 });

  return res.json({ success: true, data: referrals });
};
//create a new referral (lead) for a partner
const createReferral = async (req, res) => {
  try {
    const { customer, requirement, source } = req.body;

    if (!customer?.companyName) {
      return res.status(400).json({ success: false, message: "Customer company name is required." });
    }

    const screenCount = Number(requirement?.screenCount);
    if (!Number.isInteger(screenCount) || screenCount < 1) {
      return res.status(400).json({ success: false, message: "Enter how many screens the customer needs." });
    }

    // Partners don't set a value — only the screen count. SPOTX estimates
    // the value from screens × screen pricing on its side.
    const referral = await PartnerReferral.create({
      partnerId: req.partner._id,
      referralCode: req.partner.referral?.referralCode || "",
      customer,
      requirement: {
        screenCount,
        businessType: requirement?.businessType || "",
        notes: requirement?.notes || ""
      },
      source: source || "partner_portal",
      status: "new"
    });

    await Partner.updateOne({ _id: req.partner._id }, { $inc: { "stats.totalLeads": 1 } });

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "lead_created",
      entityType: "PartnerReferral",
      entityId: referral._id,
      description: `${req.partnerUser.name} submitted a lead for ${customer.companyName}.`,
      req
    });

    await notifyAdmins({
      type: "lead_submitted",
      title: "New lead to contact",
      message: `${partnerLabel(req.partner)} referred ${customer.companyName} (${screenCount} screen${screenCount === 1 ? "" : "s"}).`,
      link: "/admin/leads",
      audienceRoles: ["kyc_reviewer"],
      partnerId: req.partner._id,
      entityType: "PartnerReferral",
      entityId: referral._id
    });

    await notifyPartner({
      partnerId: req.partner._id,
      type: "lead_submitted",
      title: "Lead submitted",
      message: `${req.partnerUser.name} referred ${customer.companyName} (${screenCount} screen${screenCount === 1 ? "" : "s"}). SPOTX will contact them and update you here.`,
      entityType: "PartnerReferral",
      entityId: referral._id
    });

    return res.status(201).json({ success: true, message: "Lead submitted.", data: referral });
  } catch (error) {
    console.error("createReferral error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong submitting the lead." });
  }
};

/* Partner converts their own qualified referral into a pipeline opportunity */
const convertReferral = async (req, res) => {
  try {
    const referral = await PartnerReferral.findOne({ _id: req.params.id, partnerId: req.partner._id });

    if (!referral) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    if (["won", "lost", "rejected"].includes(referral.status)) {
      return res.status(400).json({ success: false, message: `Lead is already ${referral.status}.` });
    }

    const opportunity = await PartnerOpportunity.create({
      partnerId: req.partner._id,
      referralId: referral._id,
      customerId: referral.customerId,
      customer: referral.customer,
      stage: "qualification",
      expectedRevenue: referral.requirement?.estimatedValue || 0,
      expectedScreenCount: referral.requirement?.screenCount || 0
    });

    referral.status = "qualified";
    await referral.save();

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "note",
      entityType: "PartnerOpportunity",
      entityId: opportunity._id,
      description: `${req.partnerUser.name} converted a lead into an opportunity.`,
      req
    });

    return res.status(201).json({ success: true, message: "Lead converted to opportunity.", data: opportunity });
  } catch (error) {
    console.error("convertReferral error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong converting the lead." });
  }
};

module.exports = { listReferrals, createReferral, convertReferral };
