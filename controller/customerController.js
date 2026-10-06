const bcrypt = require("bcryptjs");
const { Invoice } = require("../models/Index");

/* ============================================================
   CUSTOMER — PROTECTED SELF-SERVICE
   req.customer is loaded fresh by loadCustomerContext on every
   request, so this always reflects current DB state.
============================================================ */

const shapeCustomer = (customer) => ({
  id: customer._id,
  companyName: customer.companyName,
  contactName: customer.contactName,
  email: customer.email,
  phone: customer.phone,
  address: customer.address,
  registrationSource: customer.registrationSource,
  status: customer.status,
  trial: customer.trial,
  trialExpired: customer.trialExpired,
  subscription: customer.subscription,
  createdAt: customer.createdAt
});

const getProfile = async (req, res) => {
  return res.json({ success: true, data: { customer: shapeCustomer(req.customer) } });
};

const ADDRESS_FIELDS = ["country", "state", "city", "addressLine1", "addressLine2", "pincode"];

const updateProfile = async (req, res) => {
  try {
    const { contactName, phone, address } = req.body;

    if (contactName !== undefined) req.customer.contactName = contactName;
    if (phone !== undefined) req.customer.phone = phone;

    if (address && typeof address === "object") {
      for (const field of ADDRESS_FIELDS) {
        if (address[field] !== undefined) req.customer.address[field] = address[field];
      }
    }

    await req.customer.save();

    return res.json({ success: true, message: "Profile updated.", data: { customer: shapeCustomer(req.customer) } });
  } catch (error) {
    console.error("updateProfile (customer) error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong updating your profile." });
  }
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Current and new password are required." });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: "New password must be at least 8 characters." });
    }

    const customer = await req.customer.constructor.findById(req.customer._id).select("+auth.passwordHash");

    const match = await bcrypt.compare(currentPassword, customer.auth.passwordHash);

    if (!match) {
      return res.status(401).json({ success: false, message: "Current password is incorrect." });
    }

    customer.auth.passwordHash = await bcrypt.hash(newPassword, 12);
    await customer.save();

    return res.json({ success: true, message: "Password changed." });
  } catch (error) {
    console.error("changePassword (customer) error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong changing your password." });
  }
};

const listInvoices = async (req, res) => {
  const invoices = await Invoice.find({ customerId: req.customer._id }).sort({ createdAt: -1 });

  return res.json({ success: true, data: invoices });
};

module.exports = { getProfile, updateProfile, changePassword, listInvoices };
