const asyncHandler = require("express-async-handler");
const ResellerCustomer = require("../models/ResellerCustomer");
const requirePrepaymentDone = require("../utils/requirePrepaymentDone");
const logActivity = require("../utils/logActivity");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;
const { assignReferralCode } = require("../services/vendorActivation");

/* ============================================================
   PARTNER — RESELLER CUSTOMERS
   A Reseller's own end customers — distinct from Customer.js
   (Vendor's direct SPOTX-billed customer). No resale-price field
   exists anywhere on this or the allocation model — what the
   Reseller charges its customer is out of scope for this platform
   entirely.
============================================================ */

const listCustomers = asyncHandler(async (req, res) => {
  const filter = { partnerId: req.partner._id };
  const pagination = req.query.page !== undefined ? require("../utils/pagination")(req.query) : null;
  const query = ResellerCustomer.find(filter).sort({ createdAt: -1 });
  if (pagination) query.skip(pagination.skip).limit(pagination.limit);
  const customers = await query;
  const total = pagination ? await ResellerCustomer.countDocuments(filter) : customers.length;
  return res.json({ success: true, data: customers, ...(pagination ? { pagination: { page: pagination.page, pages: Math.ceil(total / pagination.limit), total } } : {}) });
});

const getResellerReferral = asyncHandler(async (req, res) => {
  if (req.partner.status !== "active") {
    return res.status(403).json({ success: false, message: "Your reseller account must be active to invite customers." });
  }

  if (!req.partner.referral?.referralCode) {
    const referralCode = await assignReferralCode(req.partner);
    if (!referralCode) {
      return res.status(503).json({ success: false, message: "A customer referral code could not be generated. Please try again." });
    }
  }

  req.partner.referral.referralLink = `${process.env.CLIENT_URL || "http://localhost:5173"}/reseller/customer/register?ref=${req.partner.referral.referralCode}`;
  await req.partner.save();

  return res.json({ success: true, data: req.partner.referral });
});

const getCustomer = asyncHandler(async (req, res) => {
  const customer = await ResellerCustomer.findOne({ _id: req.params.id, partnerId: req.partner._id });
  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found." });
  }
  return res.json({ success: true, data: customer });
});

const createCustomer = asyncHandler(async (req, res) => {
  const { companyName, name, email, phone } = req.body;

  if (!companyName) {
    return res.status(400).json({ success: false, message: "Company name is required." });
  }

  const prepaymentGate = await requirePrepaymentDone(req.partner._id);
  if (prepaymentGate) {
    return res.status(prepaymentGate.status).json({ success: false, message: prepaymentGate.message });
  }

  const customer = await ResellerCustomer.create({
    partnerId: req.partner._id,
    businessDetails: { companyName },
    contactDetails: { name: name || "", email: email || "", phone: phone || "" },
    status: "pending"
  });

  let emailSent = false;
  if (customer.contactDetails.email) {
    try { emailSent = await require("../services/resellerCustomerAuth").sendResellerCustomerLink(customer); }
    catch (error) { console.error("Customer email delivery failed:", error.message); }
  }
  await logActivity({
    partnerId: req.partner._id,
    performedByType: "partner_user",
    performedByUserId: req.partnerUser._id,
    activityType: "reseller_customer_created",
    entityType: "ResellerCustomer",
    entityId: customer._id,
    description: `${req.partnerUser.name} added ${companyName} as a customer.`,
    req
  });

  await notifyAdmins({
    type: "reseller_customer_registered",
    title: "Reseller added a customer",
    message: `${partnerLabel(req.partner)} added ${companyName} as a customer.`,
    link: "/admin/reseller/customers",
    partnerId: req.partner._id,
    entityType: "ResellerCustomer",
    entityId: customer._id
  });

  return res.status(201).json({ success: true, message: emailSent ? "Customer added. An email was sent so they can verify and set their password." : "Customer added. They can request their verification email from the customer login page.", data: customer });
});

const updateCustomer = asyncHandler(async (req, res) => {
  const { companyName, name, email, phone } = req.body;

  const customer = await ResellerCustomer.findOne({ _id: req.params.id, partnerId: req.partner._id });
  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found." });
  }

  if (companyName !== undefined) {
    if (!companyName.trim()) {
      return res.status(400).json({ success: false, message: "Company name is required." });
    }
    customer.businessDetails.companyName = companyName.trim();
  }

  if (email !== undefined) {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail && normalizedEmail !== customer.contactDetails.email) {
      const existing = await ResellerCustomer.findOne({ "contactDetails.email": normalizedEmail, _id: { $ne: customer._id } });
      if (existing) {
        return res.status(409).json({ success: false, message: "Another customer already uses this email." });
      }
    }
    if (normalizedEmail !== customer.contactDetails.email) {
      customer.auth.emailVerified = false;
      customer.auth.sessionVersion = (customer.auth.sessionVersion || 0) + 1;
      customer.auth.verifyTokenHash = undefined;
      customer.auth.verifyTokenExpires = undefined;
    }
    customer.contactDetails.email = normalizedEmail;
  }

  if (name !== undefined) customer.contactDetails.name = name;
  if (phone !== undefined) customer.contactDetails.phone = phone;

  await customer.save();

  await logActivity({
    partnerId: req.partner._id,
    performedByType: "partner_user",
    performedByUserId: req.partnerUser._id,
    activityType: "note",
    entityType: "ResellerCustomer",
    entityId: customer._id,
    description: `${req.partnerUser.name} updated ${customer.businessDetails.companyName}'s details.`,
    req
  });

  return res.json({ success: true, message: "Customer updated.", data: customer });
});

module.exports = { listCustomers, getResellerReferral, getCustomer, createCustomer, updateCustomer };
