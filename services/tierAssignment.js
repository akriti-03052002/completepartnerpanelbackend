const { PartnerTier, Customer } = require("../models/Index");

/* ============================================================
   VENDOR AUTO TIER ASSIGNMENT
   Vendor is the only partner type with a Customer/screen-count
   concept, so it's the only one that can climb its tier ladder
   automatically — every other type still uses the admin's manual
   assignTier action (see adminPartnerController.js) since there's
   no equivalent live metric to compute from yet.
============================================================ */

// Screens currently subscribed across all of this vendor's paying
// customers. Only "active" (paid) subscriptions count — a trial,
// expired, or cancelled customer doesn't hold a screen against the
// vendor's tier.
const computeVendorScreenCount = async (partnerId) => {
  const result = await Customer.aggregate([
    { $match: { partnerId, "subscription.status": "active" } },
    { $group: { _id: null, total: { $sum: "$subscription.screenCount" } } }
  ]);
  return result[0]?.total || 0;
};

// Recomputes a Vendor's screen count and, if it now qualifies for a
// different tier, re-assigns it — defaults to the lowest tier
// (Registered, min 0) so a freshly-activated vendor always has one.
// Caller does not need to save partner afterward; this saves it.
const autoAssignVendorTier = async (partner) => {
  if (partner.partnerType !== "vendor") return null;

  const screenCount = await computeVendorScreenCount(partner._id);
  partner.stats.referredScreens = screenCount;

  const tiers = await PartnerTier.find({ partnerType: "vendor", status: "active" }).sort({ level: 1 });

  let matched = null;
  for (const tier of tiers) {
    if (screenCount >= (tier.qualification?.metric?.min ?? 0)) matched = tier;
  }

  if (matched && String(partner.program.tierId || "") !== String(matched._id)) {
    partner.program.tierId = matched._id;
    partner.program.tierAssignedAt = new Date();
    partner.program.tierAssignmentMode = "automatic";
  }

  await partner.save();
  return matched;
};

module.exports = { computeVendorScreenCount, autoAssignVendorTier };
