const jwt = require("jsonwebtoken");
const { User } = require("../models/Index");

/**
 * Fully separate from partnerAuthMiddleware — uses ADMIN_JWT_SECRET so
 * a leaked partner token can never be replayed as an admin token (and
 * vice versa) even if someone guessed the payload shape.
 */
const adminAuthMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required."
      });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET);

    const user = await User.findById(decoded.adminId);

    if (!user || user.status === "blocked") {
      return res.status(401).json({
        success: false,
        message: "Account no longer has access."
      });
    }

    req.adminAuth = decoded;
    req.adminUser = user;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token."
    });
  }
};

module.exports = adminAuthMiddleware;
