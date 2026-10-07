const PartnerCommissionAssignment = require("../models/PartnerCommissionAssignment");

/* ============================================================
   PARTNER COMMISSION RESOLVER
   Single lookup for "does this partner have a custom (vendor-only)
   commission assignment right now" — shared by commissionEngine.js
   (actual payout computation) and generatePartnerAgreement.js (what the
   agreement PDF describes), so the two can never independently drift
   out of sync. Returns the same field shape as a CommissionRule
   document (commissionType/rate/fixedAmount/perScreenAmount/hybrid/
   recurring), so callers can use whichever result (assignment or
   CommissionRule) completely interchangeably.
============================================================ */

const getActiveCommissionAssignment = (partnerId) =>
  PartnerCommissionAssignment.findOne({ partnerId, status: "active" }).sort({ assignedAt: -1 });

// Preserve existing tier contracts, then prefer a rule for this type.
// Untyped legacy rules remain a final fallback for compatibility.
const findApplicableCommissionRule = async (partner) => {
  const CommissionRule = require("../models/Commissionrule");
  const assignment = await getActiveCommissionAssignment(partner._id);
  if (assignment || partner.partnerType === "vendor") return assignment;
  const eligibleTypes = { $or: [{ partnerType: partner.partnerType }, { partnerType: null }] };
  if (partner.program?.tierId) {
    const tierRule = await CommissionRule.findOne({
      tierId: partner.program.tierId, status: "active", isAddOn: { $ne: true }, ...eligibleTypes
    }).sort({ createdAt: -1, _id: -1 });
    if (tierRule) return tierRule;
  }
  const generic = { status: "active", isAddOn: { $ne: true }, tierId: null };
  const scoped = await CommissionRule.findOne({ ...generic, partnerType: partner.partnerType }).sort({ createdAt: -1, _id: -1 });
  if (scoped) return scoped;
  return CommissionRule.findOne({ ...generic, partnerType: null }).sort({ createdAt: -1, _id: -1 });
};
module.exports = { getActiveCommissionAssignment, findApplicableCommissionRule };

