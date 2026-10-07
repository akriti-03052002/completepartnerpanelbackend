const { Customer } = require("../models/Index");

// Keep vendor screen statistics current without assigning tiers.
const computeVendorScreenCount = async (partnerId) => {
  const result = await Customer.aggregate([
    { $match: { partnerId, "subscription.status": "active" } },
    { $group: { _id: null, total: { $sum: "$subscription.screenCount" } } }
  ]);
  return result[0]?.total || 0;
};

const refreshVendorScreenCount = async (partner) => {
  if (partner.partnerType !== "vendor") return null;
  const screenCount = await computeVendorScreenCount(partner._id);
  partner.stats.referredScreens = screenCount;
  await partner.save();
  return screenCount;
};
module.exports = { computeVendorScreenCount, refreshVendorScreenCount };
