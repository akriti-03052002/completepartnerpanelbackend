const { Customer } = require("../models/Index");

/**
 * Runs after customerAuthMiddleware. Loads a fresh Customer doc onto req so
 * suspension takes effect immediately instead of waiting for the JWT to expire.
 */
const loadCustomerContext = async (req, res, next) => {
  try {
    const { customerId } = req.customerAuth;

    const customer = await Customer.findById(customerId);

    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer account not found." });
    }

    if (customer.status === "suspended") {
      return res.status(403).json({ success: false, message: "This account has been suspended. Contact your vendor." });
    }

    req.customer = customer;
    next();
  } catch (error) {
    console.error("loadCustomerContext error:", error);

    return res.status(500).json({ success: false, message: "Something went wrong loading your account." });
  }
};

module.exports = loadCustomerContext;
