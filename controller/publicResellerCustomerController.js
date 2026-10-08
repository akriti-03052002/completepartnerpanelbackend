const { issueSession } = require("../utils/browserSession");
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Partner = require("../models/Partner");
const ResellerCustomer = require("../models/ResellerCustomer");
const CustomerAllocation = require("../models/CustomerAllocation");
const Screen = require("../models/Screen");
const { PartnerNotification } = require("../models/Index");
const logActivity = require("../utils/logActivity");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;
const { sendMail } = require("../utils/mailer");
const resellerInventory = require("../services/resellerInventory");

/* ============================================================
   PUBLIC — CUSTOMER SELF-REGISTRATION VIA RESELLER REFERRAL CODE
   A reseller's own end customer signs up directly using the
   4-digit referral code the reseller shared with them (see
   Partner.referral.referralCode, generated on activation — see
   services/vendorActivation.js). This is registration only, never
   payment: the customer pays the Reseller directly for the bundled
   screen+software product, entirely outside SPOTX's system — no Razorpay, no price, no
   plan selection appears anywhere in this flow. The customer lands
   as a "pending" ResellerCustomer, same shape as if the reseller
   had added them manually from their own Customers page; the
   reseller allocates licenses to them from there.

   Registration also emails a verify link — clicking it and setting a
   password both verifies the address AND activates a minimal,
   read-only customer-portal login (see customerPortalAuthMiddleware)
   where they can see their own screens/status. Nothing more.
============================================================ */

const VERIFY_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const generateCustomerToken = (customer) =>
  jwt.sign({ customerId: customer._id, partnerId: customer.partnerId, sessionVersion: customer.auth.sessionVersion || 0 }, process.env.CUSTOMER_JWT_SECRET, { expiresIn: "30d" });

const lookupReferralCode = async (req, res) => {
  const partner = await Partner.findOne({
    "referral.referralCode": req.params.code?.trim(),
    partnerType: "reseller",
    status: "active"
  }).select("legalEntity.businessName");

  if (!partner) {
    return res.status(404).json({ success: false, message: "This referral code isn't valid." });
  }

  return res.json({
    success: true,
    data: { businessName: partner.legalEntity?.businessName || "your reseller" }
  });
};

const registerViaReferral = asyncHandler(async (req, res) => {
  const { referralCode, companyName, name, email, phone } = req.body;

  if (!referralCode?.trim()) {
    return res.status(400).json({ success: false, message: "A referral code is required." });
  }

  if (!companyName?.trim()) {
    return res.status(400).json({ success: false, message: "Company name is required." });
  }

  if (!email?.trim()) {
    return res.status(400).json({ success: false, message: "Email is required so we can send you a verification link." });
  }

  const partner = await Partner.findOne({
      "referral.referralCode": referralCode.trim(),
      partnerType: "reseller",
      status: "active"
    });

  if (!partner) {
    return res.status(404).json({ success: false, message: "This referral code isn't valid." });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await ResellerCustomer.findOne({ "contactDetails.email": normalizedEmail });
  if (existing) {
    return res.status(409).json({ success: false, message: "An account with this email already exists." });
  }

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const customer = await ResellerCustomer.create({
      partnerId: partner._id,
      businessDetails: { companyName: companyName.trim() },
      contactDetails: { name: name || "", email: normalizedEmail, phone: phone || "" },
      status: "pending",
      auth: {
        verifyTokenHash: tokenHash,
        verifyTokenExpires: new Date(Date.now() + VERIFY_TOKEN_TTL_MS)
      }
    });

  const verifyLink = `${process.env.CLIENT_URL || "http://localhost:5173"}/reseller/customer/verify/${rawToken}`;
  const businessName = partner.legalEntity?.businessName || "your reseller";

  await sendMail({
      to: normalizedEmail,
      subject: `Verify your email — you're registered with ${businessName}`,
      text: `You registered with ${businessName} on SPOTX. Verify your email and set a password to view your screens: ${verifyLink}\n\nThis link expires in 7 days.`,
      html: `
      <p>You registered with <strong>${businessName}</strong> on SPOTX.</p>
      <p><a href="${verifyLink}">Verify your email and set a password</a> to view your screens.</p>
      <p>This link expires in 7 days.</p>
      `
    });

  await PartnerNotification.create({
      partnerId: partner._id,
      type: "reseller_customer_created",
      title: "New customer signed up with your referral code",
      message: `${companyName.trim()} registered using your referral code. Review them and allocate licenses from your Customers page.`,
      entity: { type: "ResellerCustomer", entityId: customer._id }
    });

  await logActivity({
      partnerId: partner._id,
      performedByType: "system",
      activityType: "reseller_customer_created",
      entityType: "ResellerCustomer",
      entityId: customer._id,
      description: `${companyName.trim()} self-registered using the partner's referral code.`
    });

  await notifyAdmins({
      type: "reseller_customer_registered",
      title: "New reseller customer signed up",
      message: `${companyName.trim()} signed up with ${partnerLabel(partner)}'s referral code.`,
      link: `/admin/partners/${partner._id}`,
      partnerId: partner._id,
      entityType: "ResellerCustomer",
      entityId: customer._id
    });

  return res.status(201).json({
      success: true,
      message: "You're registered! Check your email to verify your address and set a password."
    });
});

const verifyAndSetPassword = asyncHandler(async (req, res) => {
  const { token, password } = req.body;

  if (typeof token !== "string" || !token) {
    return res.status(400).json({ success: false, message: "Missing verification token." });
  }

  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const customer = await ResellerCustomer.findOne({
      "auth.verifyTokenHash": tokenHash,
      "auth.verifyTokenExpires": { $gt: new Date() }
    }).select("+auth.verifyTokenHash +auth.verifyTokenExpires");

  if (!customer) {
    return res.status(400).json({ success: false, message: "This verification link is invalid or has expired." });
  }

  if (["suspended", "cancelled"].includes(customer.status)) return res.status(403).json({ success: false, message: "This account is unavailable. Contact your reseller." });
  const passwordHash = await bcrypt.hash(password, 12);
  const updated = await ResellerCustomer.findOneAndUpdate({ _id: customer._id, "auth.verifyTokenHash": tokenHash, "auth.verifyTokenExpires": { $gt: new Date() }, status: { $nin: ["suspended", "cancelled"] } }, {
    $set: { "auth.passwordHash": passwordHash, "auth.emailVerified": true },
    $unset: { "auth.verifyTokenHash": "", "auth.verifyTokenExpires": "" },
    $inc: { "auth.sessionVersion": 1 }
  }, { returnDocument: "after" });
  if (!updated) return res.status(400).json({ success: false, message: "This verification link is invalid or has expired." });

  return res.json({
      success: true,
      message: "Email verified and password set — you can log in now.",
      data: { token: issueSession(req, res, "portal", generateCustomerToken(updated)) }
    });
});

const loginCustomer = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required." });
  }

  const customer = await ResellerCustomer.findOne({ "contactDetails.email": email.toLowerCase().trim() })
      .select("+auth.passwordHash");

  if (!customer || !customer.auth?.passwordHash) {
    return res.status(401).json({ success: false, message: "Invalid email or password." });
  }

  if (["suspended", "cancelled"].includes(customer.status)) return res.status(403).json({ success: false, message: "This account is unavailable. Contact your reseller." });

  if (!customer.auth.emailVerified) {
    return res.status(403).json({ success: false, message: "Verify your email first using the link we sent you." });
  }

  const passwordMatch = await bcrypt.compare(password, customer.auth.passwordHash);
  if (!passwordMatch) {
    return res.status(401).json({ success: false, message: "Invalid email or password." });
  }

  customer.auth.lastLoginAt = new Date();
  await customer.save();

  return res.json({
      success: true,
      data: { token: issueSession(req, res, "portal", generateCustomerToken(customer)) }
    });
});

// Read-only — the customer portal doesn't let them change anything, only
// see their own company/contact info and their current screen counts.
const getMyPortalInfo = asyncHandler(async (req, res) => {
  const customer = req.resellerCustomer;
  const partner = await Partner.findById(customer.partnerId).select("legalEntity.businessName");
  const allocation = await CustomerAllocation.findOne({ customerId: customer._id, status: { $ne: "cancelled" } });

  return res.json({
      success: true,
      data: {
        companyName: customer.businessDetails.companyName,
        contactName: customer.contactDetails.name,
        email: customer.contactDetails.email,
        phone: customer.contactDetails.phone,
        status: customer.status,
        resellerName: partner?.legalEntity?.businessName || "your reseller",
        screens: {
          allocated: allocation?.allocatedLicenses || 0,
          active: allocation?.activeScreens || 0,
          suspended: allocation?.suspendedScreens || 0
        }
      }
    });
});

// List all screens registered by the authenticated customer, newest first,
// alongside how much of their allocated capacity is used — the frontend
// uses this to show "X of Y screens registered" and to know when to block
// the register button before even trying the POST.
const getMyScreens = asyncHandler(async (req, res) => {
  const customer = req.resellerCustomer;

  const [screens, allocation] = await Promise.all([
    Screen.find({ customerId: customer._id }).sort({ createdAt: -1 }),
    CustomerAllocation.findOne({ customerId: customer._id, status: { $ne: "cancelled" } })
  ]);

  return res.json({
    success: true,
    data: screens,
    meta: {
      allocatedLicenses: allocation?.allocatedLicenses || 0,
      registeredScreens: allocation?.registeredScreens || 0
    }
  });
});

// Customer registers a brand-new physical screen against their reseller's
// allocation. This is the ONLY place a Screen gets created now — allocation
// just grants capacity (see partnerAllocationController.allocateLicenses).
// Blocked once registeredScreens reaches allocatedLicenses; the customer
// has to go back to their reseller for more capacity.
const registerMyScreen = asyncHandler(async (req, res) => {
  const customer = req.resellerCustomer;
  const { name, location } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ success: false, message: "A name for this screen is required." });
  }

  const allocation = await CustomerAllocation.findOne({ customerId: customer._id, status: { $ne: "cancelled" } });

  if (!allocation || allocation.registeredScreens >= allocation.allocatedLicenses) {
    return res.status(409).json({
      success: false,
      code: "ALLOCATION_LIMIT_REACHED",
      message: "You've registered all the screens allocated to you. Contact your reseller to allocate more before registering another screen."
    });
  }

  const partnerId = customer.partnerId;
  const now = new Date();

  await resellerInventory.registerScreens({
    partnerId,
    customerId: customer._id,
    allocationId: allocation._id,
    quantity: 1,
    createdBy: customer._id
  });
  await resellerInventory.activateScreens({
    partnerId,
    customerId: customer._id,
    allocationId: allocation._id,
    quantity: 1,
    createdBy: customer._id
  });

  const screen = await Screen.create({
    customerId: customer._id,
    name: name.trim(),
    location: location?.trim() || "",
    allocationId: allocation._id,
    licenseStatus: "active",
    soldAsResellerBundle: true,
    registeredAt: now,
    activatedAt: now
  });

  allocation.registeredScreens += 1;
  allocation.activeScreens += 1;
  if (!allocation.activatedAt) allocation.activatedAt = now;
  allocation.status = "active";
  await allocation.save();

  if (customer.status !== "active") {
    customer.status = "active";
    await customer.save();
  }

  await logActivity({
    partnerId,
    performedByType: "system",
    activityType: "screen_registered",
    entityType: "Screen",
    entityId: screen._id,
    description: `${customer.businessDetails.companyName} registered a screen ("${screen.name}") — subscription starts now, no trial.`
  });

  return res.status(201).json({
    success: true,
    message: "Screen registered.",
    data: screen,
    meta: {
      allocatedLicenses: allocation.allocatedLicenses,
      registeredScreens: allocation.registeredScreens
    }
  });
});

// Customer edits an already-registered screen's label — no status
// transition happens here anymore, registerMyScreen owns that.
const updateMyScreen = asyncHandler(async (req, res) => {
  const customer = req.resellerCustomer;
  const { name, location } = req.body;

  const screen = await Screen.findOne({ _id: req.params.id, customerId: customer._id });

  if (!screen) {
    return res.status(404).json({ success: false, message: "Screen not found." });
  }

  if (name !== undefined) screen.name = name;
  if (location !== undefined) screen.location = location;

  await screen.save();

  return res.json({ success: true, data: screen });
});

const requestPasswordLink = asyncHandler(async (req, res) => {
  if (typeof req.body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.email.trim())) return res.status(400).json({ success: false, message: "Enter a valid email address." });
  const customer = await ResellerCustomer.findOne({ "contactDetails.email": req.body.email.trim().toLowerCase() });
  if (customer && !["suspended", "cancelled"].includes(customer.status)) {
    const delivered = await require("../services/resellerCustomerAuth").sendResellerCustomerLink(customer);
    if (!delivered) return res.status(503).json({ success: false, message: "Email delivery is unavailable. Try again later." });
  }
  return res.json({ success: true, message: "If this email has an available account, a verification or password link has been sent. Check your inbox and spam folder." });
});

module.exports = {
  requestPasswordLink,
  lookupReferralCode,
  registerViaReferral,
  verifyAndSetPassword,
  loginCustomer,
  getMyPortalInfo,
  getMyScreens,
  registerMyScreen,
  updateMyScreen
};
