const Billing = require("../models/ResellerBillingConfig");

// Customer/licence tasks need to know whether setup is complete, without
// granting access to advance-payment amounts or billing transactions.
module.exports = async (req, res) => {
  const permissions = req.partnerUser.permissions || [];
  if (req.partnerUser.role !== "owner" && !["reseller:customers:manage", "reseller:license:purchase"].some(permission => permissions.includes(permission))) {
    return res.status(403).json({ success: false, message: "You don't have permission to do that." });
  }
  const config = await Billing.findOne({ partnerId: req.partner._id }).select("prepayment.status").lean();
  return res.json({ success: true, data: { status: config?.prepayment?.status || "not_configured" } });
};
