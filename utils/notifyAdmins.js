const AdminNotification = require("../models/AdminNotification");

const PARTNER_TYPE_NOUN = {
  influencer: "An influencer",
  affiliate: "An affiliate",
  vendor: "A vendor",
  reseller: "A reseller"
};

// "Example Studio (PTN-DEMO01)" — business name once the profile has one,
// otherwise the contact's name.
const partnerLabel = (partner) => {
  const name = partner?.legalEntity?.businessName || partner?.primaryContact?.name ||
    PARTNER_TYPE_NOUN[partner?.partnerType] || "A partner";
  return partner?.partnerCode ? `${name} (${partner.partnerCode})` : name;
};

/**
 * Posts a notification to the admin panel for something any partner type
 * did. `audienceRoles` limits who sees it (super_admin always does; empty
 * = every admin role); pass `actorAdminId` when an admin caused the event
 * so it starts out read for them. `{name}` in the message is replaced with
 * the partner's contact name. Never throws — like logActivity, a failed
 * notification must not fail the request.
 */
const notifyAdmins = async ({
  type, title, message = "", link = "", audienceRoles = [],
  partner, partnerId, entityType, entityId, actorAdminId
}) => {
  try {
    const name = partner?.primaryContact?.name || PARTNER_TYPE_NOUN[partner?.partnerType] || "A partner";
    await AdminNotification.create({
      type,
      title,
      message: message.replace("{name}", name),
      link,
      audienceRoles,
      partnerId: partnerId || partner?._id,
      entityType,
      entityId,
      readBy: actorAdminId ? [actorAdminId] : []
    });
  } catch (error) {
    console.error("notifyAdmins failed:", error.message);
  }
};

const PLATFORM_LABEL = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };
const platformLabel = (platform) => PLATFORM_LABEL[platform] || platform;
// "an Instagram", "a YouTube", "a Facebook".
const withArticle = (word) => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;

module.exports = notifyAdmins;
module.exports.partnerLabel = partnerLabel;
module.exports.platformLabel = platformLabel;
module.exports.withArticle = withArticle;
