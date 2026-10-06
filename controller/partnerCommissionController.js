const { PartnerCommission } = require("../models/Index");

/* ============================================================
   PARTNER COMMISSION LEDGER (read-only for partners)
============================================================ */

const listCommissions = async (req, res) => {
  const commissions = await PartnerCommission.find({ partnerId: req.partner._id })
    .sort({ createdAt: -1 })
    .populate("customerId", "companyName")
    .populate("referralId", "customer.companyName");

  return res.json({ success: true, data: commissions });
};

module.exports = { listCommissions };
