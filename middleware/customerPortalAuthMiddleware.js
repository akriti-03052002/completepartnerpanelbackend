const jwt = require("jsonwebtoken");
const ResellerCustomer = require("../models/ResellerCustomer");

// Separate JWT secret from partner/admin auth — a customer-portal token
// should never be usable against any other part of the system, and vice
// versa. Loads the customer fresh on every request (not just trusting the
// token payload) so a cancelled/blocked customer loses access immediately.
const customerPortalAuthMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.CUSTOMER_JWT_SECRET);

    const customer = await ResellerCustomer.findById(decoded.customerId);

    if (!customer || customer.status === "cancelled") {
      return res.status(401).json({ success: false, message: "Invalid or expired session." });
    }

    req.resellerCustomer = customer;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token." });
  }
};

module.exports = customerPortalAuthMiddleware;
