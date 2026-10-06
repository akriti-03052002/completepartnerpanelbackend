/**
 * Gates everything except KYC document upload / bank submission (and
 * dashboard/profile/notifications) behind full verification. A partner's
 * status only becomes "active" once documents + bank are both verified
 * (see services/vendorActivation.js) — until then, there's nothing
 * legitimate to refer, sell, or get paid for yet.
 */
const requireVerifiedPartner = (req, res, next) => {
  if (req.partner.status !== "active") {
    return res.status(403).json({
      success: false,
      locked: true,
      message: req.partner.status === "rejected"
        ? "Your partner account was rejected — check your Dashboard for the reason. Re-submit corrected documents or bank details to be reconsidered."
        : "This feature unlocks once SPOTX verifies your KYC documents and bank account."
    });
  }

  next();
};

module.exports = requireVerifiedPartner;
