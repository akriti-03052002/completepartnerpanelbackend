const { Customer } = require("../models/Index");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;
const { sendCustomerSetPasswordEmail } = require("../services/customerAuth");

/* ============================================================
   PARTNER — CUSTOMERS (VENDOR'S END CUSTOMERS)
   Covers both registration paths: a vendor registering a
   customer directly, and customers who self-registered with
   the vendor's referral code (both land in the same list,
   scoped to req.partner._id).
============================================================ */

const listCustomers = async (req, res) => {
  const filter = { partnerId: req.partner._id };
  const pagination = req.query.page !== undefined ? require("../utils/pagination")(req.query) : null;
  const query = Customer.find(filter).sort({ createdAt: -1 });
  if (pagination) query.skip(pagination.skip).limit(pagination.limit);
  const customers = await query;
  const total = pagination ? await Customer.countDocuments(filter) : customers.length;

  return res.json({ success: true, data: customers, ...(pagination ? { pagination: { page: pagination.page, pages: Math.ceil(total / pagination.limit), total } } : {}) });
};

const getCustomer = async (req, res) => {
  const customer = await Customer.findOne({ _id: req.params.id, partnerId: req.partner._id });

  if (!customer) {
    return res.status(404).json({ success: false, message: "Customer not found." });
  }

  return res.json({ success: true, data: customer });
};

// Method 1 from the spec: the vendor registers the customer directly.
// No password field here — the vendor shouldn't set or know the
// customer's password, so the customer gets emailed a link to set their
// own, the same way an admin-invited partner does (see
// adminPartnerController.createPartner).
const createCustomer = async (req, res) => {
  try {
    // requireVerifiedPartner (mounted on this whole route group) already
    // guarantees req.partner.status === "active" here.
    if (req.partner.partnerType !== "vendor") {
      return res.status(403).json({ success: false, message: "Customer registration is only available to Vendor partners." });
    }

    const {
      companyName, contactName, email, phone,
      country, state, city, addressLine1, addressLine2, pincode
    } = req.body;

    if (typeof companyName !== "string" || !companyName.trim() || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, message: "Company name and email are required." });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await Customer.exists({ email: normalizedEmail });

    if (existing) {
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }

    const now = new Date();
    const trialEndsAt = new Date(now.getTime() + Customer.TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

    const customer = await Customer.create({
      companyName,
      contactName: contactName || "",
      email: normalizedEmail,
      phone: phone || "",
      address: {
        country: country || "India",
        state: state || "",
        city: city || "",
        addressLine1: addressLine1 || "",
        addressLine2: addressLine2 || "",
        pincode: pincode || ""
      },
      partnerId: req.partner._id,
      registrationSource: "partner_direct",
      auth: { emailVerified: false },
      trial: { startedAt: now, endsAt: trialEndsAt },
      subscription: { status: "trial" }
    });

    await sendCustomerSetPasswordEmail(customer, { isNewAccount: true });

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "note",
      entityType: "Customer",
      entityId: customer._id,
      description: `${req.partnerUser.name} registered ${companyName} as a customer.`,
      req
    });

    await notifyPartner({
      partnerId: req.partner._id,
      type: "customer_registered",
      title: "Customer registered",
      message: `${req.partnerUser.name} registered ${companyName}. Their 30-day trial has started; you earn commission when they pay for a subscription.`,
      entityType: "Customer",
      entityId: customer._id
    });

    await notifyAdmins({
      type: "vendor_customer_registered",
      title: "Vendor registered a customer",
      message: `${partnerLabel(req.partner)} registered ${companyName} as a customer. Their 30-day trial has started.`,
      link: `/admin/partners/${req.partner._id}`,
      partnerId: req.partner._id,
      entityType: "Customer",
      entityId: customer._id
    });

    return res.status(201).json({
      success: true,
      message: `Customer registered. An email was sent to ${normalizedEmail} for them to set their password. 30-day trial started.`,
      data: customer
    });
  } catch (error) {
    console.error("createCustomer error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong registering the customer." });
  }
};

// Credential reset (partner_direct or otherwise) is admin-only — see
// adminCustomerController.resetCustomerCredentials. A partner shouldn't
// have visibility into, or the ability to set, their customers' login
// credentials at all.

module.exports = { listCustomers, getCustomer, createCustomer };
