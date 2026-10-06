const { PartnerCommission, PartnerNotification, Partner } = require("../models/Index");
const mongoose = require("mongoose");
const { PARTNER_TYPES } = require("../config/constant");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");
const { settleApprovedCommission, removeCommissionFromSettlement } = require("../services/autoSettlement");
const { earningNounFor, capitalize, rupees } = notifyPartner;

/* ============================================================
   ADMIN — COMMISSION APPROVAL
   Approving a commission is all it takes to queue it for payout:
   it goes straight into a ready-to-pay settlement (see
   services/autoSettlement.js). There is no separate "create
   settlement" step.
============================================================ */

const listCommissions = async (req, res) => {
  const { status, partnerId, partnerType } = req.query;

  const filter = {};
  if (status) filter["settlement.status"] = status;
  if (partnerId) filter.partnerId = partnerId;

  if (partnerId && !mongoose.isValidObjectId(partnerId)) {
    return res.status(400).json({ success: false, message: "Invalid partner ID." });
  }

  if (partnerType) {
    if (!PARTNER_TYPES.includes(partnerType)) {
      return res.status(400).json({ success: false, message: "Invalid partner type." });
    }
    const matchingPartnerIds = await Partner.find({ partnerType }).distinct("_id");
    if (matchingPartnerIds.length === 0) {
      return res.json({ success: true, data: [] });
    }
    if (partnerId && !matchingPartnerIds.some((id) => String(id) === partnerId)) {
      return res.json({ success: true, data: [] });
    }
    filter.partnerId = partnerId || { $in: matchingPartnerIds };
  }

  const commissions = await PartnerCommission.find(filter)
    .sort({ createdAt: -1 })
    .populate("partnerId", "partnerCode partnerType legalEntity.businessName");

  return res.json({ success: true, data: commissions });
};

const approveCommission = async (req, res) => {
  try {
    const commission = await PartnerCommission.findById(req.params.id);

    if (!commission) {
      return res.status(404).json({ success: false, message: "Commission not found." });
    }

    if (commission.settlement.status !== "pending") {
      return res.status(400).json({ success: false, message: `Commission is already ${commission.settlement.status}.` });
    }

    commission.settlement.status = "approved";
    await commission.save();

    // "content earning" / "referral reward" / "commission" — whatever this
    // partner's type calls it.
    const noun = await earningNounFor(commission.partnerId);

    // Approved means queued for payout: it joins the partner's open
    // settlement, or opens a new one.
    const { settlement, created } = await settleApprovedCommission(commission, { byUserId: req.adminUser._id, req });
    const onHold = settlement.status === "on_hold";

    await logActivity({
      partnerId: commission.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "commission_approved",
      entityType: "PartnerCommission",
      entityId: commission._id,
      description: `${req.adminUser.name} approved a commission.`,
      req
    });

    await PartnerNotification.create({
      partnerId: commission.partnerId,
      type: "commission_approved",
      title: `${capitalize(noun)} approved`,
      message: `Your ${noun} of ${rupees(commission.calculation.netCommission)} was approved and ${created ? "is in" : "was added to"} settlement ${settlement.settlementNumber} (${rupees(settlement.amount.net)}).${onHold ? " The settlement is on hold — see Settlements for what is needed." : " It will be paid to your bank account."}`,
      entity: { type: "PartnerCommission", entityId: commission._id }
    });

    return res.json({
      success: true,
      message: onHold
        ? `Commission approved and placed in settlement ${settlement.settlementNumber}, which is on hold: ${settlement.hold?.reason || "see Settlements"}`
        : `Commission approved — it is in settlement ${settlement.settlementNumber}, ready to pay.`,
      data: commission,
      settlement: { _id: settlement._id, settlementNumber: settlement.settlementNumber, status: settlement.status, net: settlement.amount.net }
    });
  } catch (error) {
    console.error("approveCommission error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong approving the commission." });
  }
};

// "Hold" isn't its own settlement.status — it takes an approved commission
// back out of its (not yet paid) settlement and returns it to pending, so
// it isn't paid until it is approved again. The reason lives in the
// activity log since there's no dedicated field for it.
const holdCommission = async (req, res) => {
  try {
    const { reason } = req.body;
    const commission = await PartnerCommission.findById(req.params.id);

    if (!commission) {
      return res.status(404).json({ success: false, message: "Commission not found." });
    }

    if (!["approved", "eligible"].includes(commission.settlement.status)) {
      return res.status(400).json({
        success: false,
        message: `Only an approved, unpaid commission can be put on hold (this one is ${commission.settlement.status}).`
      });
    }

    const removal = await removeCommissionFromSettlement(commission, { byUserId: req.adminUser._id, req });
    if (!removal.ok) {
      return res.status(400).json({ success: false, message: removal.message });
    }

    commission.settlement.status = "pending";
    await commission.save();

    await logActivity({
      partnerId: commission.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "PartnerCommission",
      entityId: commission._id,
      description: `${req.adminUser.name} put this commission on hold${reason ? `: ${reason}` : "."}`,
      req
    });

    const noun = await earningNounFor(commission.partnerId);
    await notifyPartner({
      partnerId: commission.partnerId,
      type: "commission_held",
      title: `${capitalize(noun)} put on hold`,
      message: `Your ${noun} of ${rupees(commission.calculation.netCommission)} was put on hold${reason ? `: ${reason}` : "."} It won't be settled until SPOTX approves it again.`,
      entityType: "PartnerCommission",
      entityId: commission._id
    });

    return res.json({ success: true, message: "Commission put on hold.", data: commission });
  } catch (error) {
    console.error("holdCommission error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong holding the commission." });
  }
};

// Full reversal (e.g. the underlying customer payment was refunded). A
// commission sitting in a not-yet-paid settlement is taken out of it first,
// and that batch's totals are recalculated.
const reverseCommission = async (req, res) => {
  try {
    const { reason } = req.body;
    const commission = await PartnerCommission.findById(req.params.id);

    if (!commission) {
      return res.status(404).json({ success: false, message: "Commission not found." });
    }

    if (commission.settlement.status === "cancelled") {
      return res.status(400).json({ success: false, message: "This commission is already cancelled." });
    }

    if (commission.settlement.status === "eligible") {
      const removal = await removeCommissionFromSettlement(commission, { byUserId: req.adminUser._id, req });
      if (!removal.ok) {
        return res.status(400).json({ success: false, message: removal.message });
      }
    }

    const partner = await Partner.findById(commission.partnerId);
    const amount = commission.calculation.netCommission;

    if (commission.settlement.status === "settled") {
      partner.stats.paidCommission = Math.max(0, partner.stats.paidCommission - amount);
    } else {
      partner.stats.pendingCommission = Math.max(0, partner.stats.pendingCommission - amount);
    }
    partner.stats.totalCommission = Math.max(0, partner.stats.totalCommission - amount);
    await partner.save();

    commission.settlement.status = "cancelled";
    await commission.save();

    await logActivity({
      partnerId: commission.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "PartnerCommission",
      entityId: commission._id,
      description: `${req.adminUser.name} reversed a commission of ${amount.toFixed(2)}${reason ? `: ${reason}` : "."}`,
      req
    });

    const noun = await earningNounFor(commission.partnerId);
    await PartnerNotification.create({
      partnerId: commission.partnerId,
      type: "commission_reversed",
      title: `${capitalize(noun)} reversed`,
      message: `Your ${noun} of ${rupees(amount)} was reversed${reason ? `: ${reason}` : "."}`,
      entity: { type: "PartnerCommission", entityId: commission._id }
    });

    return res.json({ success: true, message: "Commission reversed.", data: commission });
  } catch (error) {
    console.error("reverseCommission error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong reversing the commission." });
  }
};

module.exports = { listCommissions, approveCommission, holdCommission, reverseCommission };
