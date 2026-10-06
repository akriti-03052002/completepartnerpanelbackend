const jwt = require("jsonwebtoken");

// Same JWT_SECRET as partner tokens, but a customer token only ever carries
// `customerId` (never userId/partnerId/role), so a partner or admin token
// replayed here is rejected even though the secret is shared.
const customerAuthMiddleware = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (!decoded.customerId) {
      return res.status(401).json({ success: false, message: "Invalid or expired token." });
    }

    req.customerAuth = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Invalid or expired token." });
  }
};

module.exports = customerAuthMiddleware;
