/**
 * Requires adminAuthMiddleware to have run first.
 * requireAdminRole("super_admin", "finance") allows either role through.
 */
const requireAdminRole = (...allowedRoles) => (req, res, next) => {
  const { adminUser } = req;

  if (!adminUser) {
    return res.status(401).json({
      success: false,
      message: "Authentication required."
    });
  }

  if (adminUser.role === "super_admin" || allowedRoles.includes(adminUser.role)) {
    return next();
  }

  return res.status(403).json({
    success: false,
    message: "You don't have permission to do that."
  });
};

module.exports = requireAdminRole;
