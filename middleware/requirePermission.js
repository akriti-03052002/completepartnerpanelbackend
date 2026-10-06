/**
 * Requires loadPartnerContext to have run first (needs req.partnerUser).
 * Owners bypass all checks. Everyone else needs the permission string
 * present on their PartnerUser.permissions array.
 */
const requirePermission = (permission) => (req, res, next) => {
  const { partnerUser } = req;

  if (!partnerUser) {
    return res.status(401).json({
      success: false,
      message: "Authentication required."
    });
  }

  if (partnerUser.role === "owner") {
    return next();
  }

  if (!partnerUser.permissions.includes(permission)) {
    return res.status(403).json({
      success: false,
      message: "You don't have permission to do that."
    });
  }

  next();
};

module.exports = requirePermission;
