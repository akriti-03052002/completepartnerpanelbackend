const { Partner, PartnerNotification } = require("../models/Index");

/* ============================================================
   PARTNER NOTIFICATIONS
   Everything that happens to a partner's own work shows up in their
   notification bell: their leads (Affiliate), posts / reels and
   social accounts (Influencer), customers (Vendor), licenses and
   invoices (Reseller), and — for the types that get paid — every
   step of an earning and its settlement.

   Never throws: like logActivity, a failed notification must not
   fail the action it describes.
============================================================ */

const notifyPartner = async ({ partnerId, type, title, message = "", entityType, entityId }) => {
  try {
    if (!partnerId) return;
    await PartnerNotification.create({
      partnerId,
      type,
      title,
      message,
      entity: entityType ? { type: entityType, entityId } : undefined
    });
  } catch (error) {
    console.error("notifyPartner failed:", error.message);
  }
};

// What each commission-earning type calls the money it earns — the same
// words as its own menu ("Content Earnings", "Referral Rewards",
// "Customer Commissions"). A Reseller earns nothing, so it never gets one
// of these.
const EARNING_NOUN = {
  influencer: "content earning",
  affiliate: "referral reward",
  vendor: "commission"
};

const earningNoun = (partnerType) => EARNING_NOUN[partnerType] || "commission";

// For callers that only have the partner's id.
const earningNounFor = async (partnerId) => {
  const partner = await Partner.findById(partnerId).select("partnerType").lean();
  return earningNoun(partner?.partnerType);
};

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const rupees = (amount) => `₹${(Number(amount) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

module.exports = notifyPartner;
module.exports.earningNoun = earningNoun;
module.exports.earningNounFor = earningNounFor;
module.exports.capitalize = capitalize;
module.exports.rupees = rupees;
