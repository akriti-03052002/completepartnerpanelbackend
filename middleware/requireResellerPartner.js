/**
 * Gates every Reseller-only route. Mounted after partnerAuthMiddleware
 * + loadPartnerContext (+ requireVerifiedPartner where applicable) —
 * same pattern as the inline partnerType check already used in
 * partnerCustomerController.createCustomer for Vendor-only routes.
 */
const requireResellerPartner = (req, res, next) => {
  if (req.partner.partnerType !== "reseller") {
    return res.status(403).json({
      success: false,
      message: "This feature is only available to Reseller partners."
    });
  }

  next();
};

module.exports = requireResellerPartner;
