const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Partner, Customer, PartnerNotification } = require("../models/Index");
const logActivity = require("../utils/logActivity");
const { sendCustomerSetPasswordEmail } = require("../services/customerAuth");

/* ============================================================
   PUBLIC — CUSTOMER SIGNUP VIA VENDOR REFERRAL CODE
   No auth required. A Vendor partner's numeric referral code
   (generated once SPOTX verifies them) is the entry point.
============================================================ */

const generateToken = (customer) =>
  jwt.sign({ customerId: customer._id }, process.env.JWT_SECRET, { expiresIn: "1d" });

const lookupReferralCode = async (req, res) => {
  const { code } = req.params;

  const partner = await Partner.findOne({
    "referral.referralCode": code,
    partnerType: "vendor",
    status: "active"
  }).select("legalEntity.businessName partnerCode");

  if (!partner) {
    return res.status(404).json({ success: false, message: "This referral code isn't valid or is no longer active." });
  }

  return res.json({
    success: true,
    data: { partnerId: partner._id, businessName: partner.legalEntity.businessName }
  });
};

const registerCustomer = async (req, res) => {
  try {
    const {
      referralCode, companyName, contactName, email, phone, password,
      country, state, city, addressLine1, addressLine2, pincode
    } = req.body;

    if (typeof referralCode !== "string" || !referralCode.trim() || typeof companyName !== "string" || !companyName.trim() || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || typeof password !== "string" || !password) {
      return res.status(400).json({ success: false, message: "Referral code, company name, email and password are required." });
    }

    if (password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
    }

    const partner = await Partner.findOne({
      "referral.referralCode": referralCode,
      partnerType: "vendor",
      status: "active"
    });

    if (!partner) {
      return res.status(400).json({ success: false, message: "This referral code isn't valid or is no longer active." });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await Customer.exists({ email: normalizedEmail });

    if (existing) {
      // Same guard doubles as trial-abuse prevention — one email, one trial.
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
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
      partnerId: partner._id,
      registrationSource: "referral_code",
      auth: { passwordHash, emailVerified: false },
      trial: { startedAt: now, endsAt: trialEndsAt },
      subscription: { status: "trial" }
    });

    let emailSent = false;
    try {
      emailSent = await sendCustomerSetPasswordEmail(customer, { isNewAccount: true });
    } catch (error) {
      console.error("Customer verification email delivery failed:", error.message);
    }

    await logActivity({
      partnerId: partner._id,
      performedByType: "system",
      activityType: "note",
      entityType: "Customer",
      entityId: customer._id,
      description: `${companyName} registered as a customer using your referral code — 30-day trial started.`,
      req
    });

    await PartnerNotification.create({
      partnerId: partner._id,
      type: "customer_registered",
      title: "New customer registered",
      message: `${companyName} signed up with your referral code and started a 30-day trial.`,
      entity: { type: "Customer", entityId: customer._id }
    });

    return res.status(201).json({
      success: true,
      message: emailSent ? "Check your email to verify your address and confirm your password before logging in." : "Account created, but the verification email could not be sent. Use the resend link to try again.",
      data: {
        emailSent,
        requiresEmailVerification: true,
        customer: {
          id: customer._id,
          companyName: customer.companyName,
          contactName: customer.contactName,
          email: customer.email,
          phone: customer.phone,
          subscriptionStatus: customer.subscription.status,
          screenCount: customer.subscription.screenCount,
          trialEndsAt: customer.trial.endsAt,
          trialExpired: customer.trialExpired
        }
      }
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "An account with this email already exists." });
    console.error("registerCustomer error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong during registration." });
  }
};

const loginCustomer = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const customer = await Customer.findOne({ email: email.toLowerCase().trim() }).select("+auth.passwordHash");

    if (!customer) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    // A partner-registered customer starts with no passwordHash — they
    // need the activation email's link before they can log in at all.
    if (!customer.auth.passwordHash) {
      return res.status(403).json({
        success: false,
        message: "Set your password first using the link sent to your email."
      });
    }

    if (customer.status === "suspended") {
      return res.status(403).json({ success: false, message: "This account has been suspended. Contact your vendor." });
    }

    const match = await bcrypt.compare(password, customer.auth.passwordHash);

    if (!match) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    if (customer.auth.emailVerified === false) {
      return res.status(403).json({ success: false, code: "EMAIL_NOT_VERIFIED", message: "Verify your email first. Use the resend verification link if needed." });
    }

    customer.auth.lastLoginAt = new Date();
    await customer.save();

    return res.json({
      success: true,
      message: "Login successful.",
      data: {
        token: generateToken(customer),
        customer: {
          id: customer._id,
          companyName: customer.companyName,
          contactName: customer.contactName,
          email: customer.email,
          phone: customer.phone,
          subscriptionStatus: customer.subscription.status,
          screenCount: customer.subscription.screenCount,
          trialEndsAt: customer.trial.endsAt,
          trialExpired: customer.trialExpired
        }
      }
    });
  } catch (error) {
    console.error("loginCustomer error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong during login." });
  }
};

// =====================================================
// FORGOT / RESET PASSWORD
// Same token mechanism used to activate a partner-registered customer's
// account in the first place (see partnerCustomerController.createCustomer)
// — this is the self-service path for a customer who already has a
// password but forgot it.
// =====================================================

const forgotCustomerPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const genericResponse = {
      success: true,
      message: "If an account exists for that email, a reset link has been sent."
    };

    const customer = await Customer.findOne({ email: email.toLowerCase().trim() });

    if (!customer) {
      return res.json(genericResponse);
    }

    const delivered = await sendCustomerSetPasswordEmail(customer, { isNewAccount: customer.auth.emailVerified === false });
    if (!delivered) return res.status(503).json({ success: false, message: "Email delivery is unavailable. Please try again later or contact support." });

    return res.json(genericResponse);
  } catch (error) {
    console.error("forgotCustomerPassword error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong processing the request." });
  }
};

const resetCustomerPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const customer = await Customer.findOne({
      "auth.resetTokenHash": tokenHash,
      "auth.resetTokenExpires": { $gt: new Date() }
    }).select("+auth.resetTokenHash +auth.resetTokenExpires");

    if (!customer) {
      return res.status(400).json({ success: false, message: "This link is invalid or has expired." });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const updated = await Customer.findOneAndUpdate({
      _id: customer._id,
      "auth.resetTokenHash": tokenHash,
      "auth.resetTokenExpires": { $gt: new Date() }
    }, {
      $set: { "auth.passwordHash": passwordHash, "auth.emailVerified": true },
      $unset: { "auth.resetTokenHash": "", "auth.resetTokenExpires": "" }
    });
    if (!updated) return res.status(400).json({ success: false, message: "This link is invalid or has expired." });

    return res.json({ success: true, message: "Email verified and password set. You can now log in." });
  } catch (error) {
    console.error("resetCustomerPassword error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong setting the password." });
  }
};

module.exports = { lookupReferralCode, registerCustomer, loginCustomer, forgotCustomerPassword, resetCustomerPassword };
