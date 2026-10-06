const { PartnerSettlement, SettlementSetting, PartnerCommission } = require("../models/Index");
const PartnerSettlementBill = require("../models/PartnerSettlementBill");
const { getSettlementHistory } = require("../utils/settlementHistory");

/* ============================================================
   PARTNER SETTLEMENT / PAYOUT HISTORY (read-only for partners)
============================================================ */

/* Only monthly/quarterly cycles have a fixed calendar day to project
   forward from — threshold/manual settlements fire on-demand, so
   there's no next date to compute. No anchor date is stored for
   quarterly cycles, so this rolls 3 calendar months forward from
   today rather than aligning to a fixed Jan/Apr/Jul/Oct-style quarter. */
const computeNextSettlementDate = (setting) => {
  if (!setting || !["monthly", "quarterly"].includes(setting.settlementType) || !setting.settlementDay) {
    return null;
  }

  const day = setting.settlementDay;
  const now = new Date();
  const monthsPerCycle = setting.settlementType === "quarterly" ? 3 : 1;

  let candidate = new Date(now.getFullYear(), now.getMonth(), day);
  if (candidate <= now) {
    candidate = new Date(now.getFullYear(), now.getMonth() + monthsPerCycle, day);
  }

  // Clamp overflow days (e.g. settlementDay 31 in a 30-day month) to the month's last day
  if (candidate.getDate() !== day) {
    candidate = new Date(candidate.getFullYear(), candidate.getMonth() + 1, 0);
  }

  return candidate;
};

const listSettlements = async (req, res) => {
  const [settlements, setting, breakdownRows] = await Promise.all([
    PartnerSettlement.find({ partnerId: req.partner._id }).sort({ createdAt: -1 }),
    SettlementSetting.findOne({ partnerId: req.partner._id }),
    // availableBalance is one lump number — a partner staring at it with
    // zero rows in the settlements table below has no way to tell "held
    // pending admin approval" from "approved, just not batched yet" apart.
    // This splits it by PartnerCommission.settlement.status so the UI can
    // explain the hold instead of just showing a number with no rows.
    PartnerCommission.aggregate([
      { $match: { partnerId: req.partner._id, "settlement.status": { $in: ["pending", "approved"] } } },
      { $group: { _id: "$settlement.status", total: { $sum: "$calculation.netCommission" } } }
    ])
  ]);

  const breakdown = { pending: 0, approved: 0 };
  for (const row of breakdownRows) breakdown[row._id] = row.total;
  const bills = await PartnerSettlementBill.find(
    { settlementId: { $in: settlements.map((settlement) => settlement._id) } },
    "settlementId status amount.gstRatePercent amount.gstAmount"
  ).lean();
  const billsBySettlementId = new Map(bills.map((bill) => [String(bill.settlementId), bill]));

  return res.json({
    success: true,
    data: settlements.map((settlement) => ({
      ...settlement.toObject(),
      bill: billsBySettlementId.get(String(settlement._id)) || null
    })),
    meta: {
      settlementType: setting?.settlementType || null,
      minimumSettlementAmount: setting?.minimumSettlementAmount || 0,
      nextSettlementDate: computeNextSettlementDate(setting),
      hasSettlementSetting: !!setting,
      // Commission earned but not yet paid out — the same balance the
      // settlement job draws down when a payout is marked paid, so it
      // reads as the partner's "available for settlement" amount.
      availableBalance: req.partner.stats?.pendingCommission || 0,
      pendingApprovalAmount: breakdown.pending,
      approvedAwaitingBatchAmount: breakdown.approved,
      currency: "INR"
    }
  });
};

/* Settlement breakdown view — mirrors a Razorpay-style settlement
   detail: amount waterfall (gross -> deductions -> net) plus the
   underlying commission line items bundled into this payout. */
const getSettlementDetail = async (req, res) => {
  const settlement = await PartnerSettlement.findOne({
    _id: req.params.id,
    partnerId: req.partner._id
  }).populate({
    path: "commissionIds",
    select: "transaction.invoiceNumber transaction.revenue transaction.currency calculation.commissionType calculation.rate calculation.fixedAmount calculation.grossCommission calculation.deductions calculation.netCommission createdAt"
  });

  if (!settlement) {
    return res.status(404).json({ success: false, message: "Settlement not found." });
  }

  return res.json({ success: true, data: settlement });
};

// Partner-facing timeline — same underlying rows as the admin view, no
// admin-only fields (performedByUserId isn't populated/named here) beyond
// what's already visible: action, status transition, reason, amount.
const getSettlementHistoryForPartner = async (req, res) => {
  const settlement = await PartnerSettlement.findOne({ _id: req.params.id, partnerId: req.partner._id }, "_id");
  if (!settlement) {
    return res.status(404).json({ success: false, message: "Settlement not found." });
  }

  const history = await getSettlementHistory(settlement._id);
  return res.json({ success: true, data: history });
};

module.exports = { listSettlements, getSettlementDetail, getSettlementHistoryForPartner };
