const { PartnerUser, Partner } = require("../models/Index");
const { isPartnerFullyVerified, isProfileComplete } = require("../utils/partnerVerification");

/**
 * Runs after partnerAuthMiddleware. Loads fresh PartnerUser + Partner
 * docs onto req so permission checks always reflect the current role/
 * status instead of whatever was baked into the JWT at login time.
 */
const loadPartnerContext = async (req, res, next) => {
  try {
    const { userId } = req.partnerAuth;

    const partnerUser = await PartnerUser.findById(userId);

    if (!partnerUser || partnerUser.status === "blocked" || (req.partnerAuth.sessionVersion || 0) !== (partnerUser.auth.sessionVersion || 0)) {
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

    // An old Active flag cannot bypass missing/replaced KYC or bank review.
    // Check the latest required documents, rather than historical approvals.
    if (partner.status === "active" && (!isProfileComplete(partner) || !(await isPartnerFullyVerified(partner._id, partner.partnerType)))) {
      const updated = await Partner.findOneAndUpdate(
        { _id: partner._id, status: "active" },
        { $set: { status: "pending_verification", "verification.overallStatus": "pending" }, $unset: { "verification.verifiedAt": 1, "verification.verifiedBy": 1 } },
        { returnDocument: "after" }
      );
      // Reload if an admin changed the status concurrently.
      req.partner = updated || await Partner.findById(partner._id);
    } else {
      req.partner = partner;
    }

    req.partnerUser = partnerUser;

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
