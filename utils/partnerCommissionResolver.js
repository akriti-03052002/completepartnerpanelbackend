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

module.exports = { getActiveCommissionAssignment };
