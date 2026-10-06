const { PartnerUser, Partner } = require("../models/Index");

/**
 * Runs after partnerAuthMiddleware. Loads fresh PartnerUser + Partner
 * docs onto req so permission checks always reflect the current role/
 * status instead of whatever was baked into the JWT at login time.
 */
const loadPartnerContext = async (req, res, next) => {
  try {
    const { userId } = req.partnerAuth;

    const partnerUser = await PartnerUser.findById(userId);

    if (!partnerUser || partnerUser.status === "blocked") {
      return res.status(401).json({
        success: false,
        message: "Account no longer has access."
      });
    }

    const partner = await Partner.findById(partnerUser.partnerId);

    if (!partner) {
      return res.status(404).json({
        success: false,
        message: "Partner account not found."
      });
    }

    // Suspended is a harsher, active-partner-gone-wrong state — full lockout
    // is correct there. Rejected happens during onboarding review instead,
    // and the partner needs to actually log in to see why (Dashboard),
    // get notified, and re-submit corrected documents/bank details — so it
    // stays gated by requireVerifiedPartner (status !== "active") like any
    // other not-yet-verified partner, not blocked here entirely.
    if (partner.status === "suspended") {
      return res.status(403).json({
        success: false,
        message: `Your partner account is ${partner.status}. Contact SPOTX support.`
      });
    }

    req.partnerUser = partnerUser;
    req.partner = partner;

    next();
  } catch (error) {
    console.error("loadPartnerContext error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong loading your account."
    });
  }
};

module.exports = loadPartnerContext;
