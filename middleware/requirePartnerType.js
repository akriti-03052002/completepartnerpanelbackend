const LABELS = {
  influencer: "Influencer",
  affiliate: "Affiliate",
  vendor: "Vendor",
  reseller: "Reseller"
};

/**
 * Gates a route group to the partner types it belongs to. Mounted after
 * partnerAuthMiddleware + loadPartnerContext — the frontend already hides
 * these pages per type (see PartnerTypeRoute in App.jsx); this is the
 * matching server-side check so the API can't be called directly.
 */
const requirePartnerType = (...allowedTypes) => (req, res, next) => {
  if (!allowedTypes.includes(req.partner.partnerType)) {
    return res.status(403).json({
      success: false,
      message: `This feature is only available to ${allowedTypes.map((type) => LABELS[type] || type).join(", ")} partners.`
    });
  }

  next();
};

module.exports = requirePartnerType;
