const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const { Partner, PartnerUser, PartnerNotification, EmailOtp, OtpRateLimit } = require("../models/Index");
const { generatePartnerCode, generateReferralCode } = require("../utils/generateCode");
const { ROLE_PERMISSIONS } = require("../config/roles");
const logActivity = require("../utils/logActivity");
const notifyAdmins = require("../utils/notifyAdmins");
const { sendMail } = require("../utils/mailer");

// =====================================================
// GENERATE JWT
// =====================================================

const generateToken = (user) => {
  return jwt.sign(
    { userId: user._id, partnerId: user.partnerId, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "1d" }
  );
};

// =====================================================
// EMAIL OTP — registration email verification
// Two-step: sendEmailOtp emails a 6-digit code and upserts an EmailOtp
// record; verifyEmailOtp checks it and hands back a single-use
// verificationToken. registerPartner requires that token rather than
// trusting a client-side "verified" flag, so the OTP step can't be
// skipped by calling /register directly.
// =====================================================

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const OTP_VERIFIED_GRACE_MS = 30 * 60 * 1000; // how long a verified token stays usable for registration
const OTP_MAX_ATTEMPTS = 5;
// Persistent OTP send throttling — stored in the database, so unlike the
// in-memory express-rate-limit on the route it survives restarts and holds
// across multiple server instances.
const OTP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const OTP_MAX_REQUESTS_PER_EMAIL = 3;
const OTP_MAX_REQUESTS_PER_IP = 10;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;

const hashOtp = (otp) => crypto.createHash("sha256").update(otp).digest("hex");

const hashValue = (value) => crypto.createHash("sha256").update(String(value).trim().toLowerCase()).digest("hex");

const enforceOtpRequestLimit = async ({ email, ipHash }) => {
  const now = Date.now();
  const record = await EmailOtp.findOne({ email });

  if (record?.lastSentAt && now - new Date(record.lastSentAt).getTime() < OTP_RESEND_COOLDOWN_MS) {
    throw Object.assign(new Error("Please wait 60 seconds before requesting another OTP."), { status: 429 });
  }

  if (record?.firstRequestAt && now - new Date(record.firstRequestAt).getTime() < OTP_RATE_LIMIT_WINDOW_MS) {
    if ((record.requestCount || 0) >= OTP_MAX_REQUESTS_PER_EMAIL) {
      throw Object.assign(new Error("Too many OTP requests for this email. Try again later."), { status: 429 });
    }
  }

  const ipLimit = await OtpRateLimit.findOne({ key: ipHash, kind: "ip" });
  if (ipLimit) {
    const windowStart = ipLimit.windowStart ? new Date(ipLimit.windowStart).getTime() : 0;
    if (now - windowStart < OTP_RATE_LIMIT_WINDOW_MS && (ipLimit.count || 0) >= OTP_MAX_REQUESTS_PER_IP) {
      throw Object.assign(new Error("Too many OTP requests from this network. Try again later."), { status: 429 });
    }
  }
};

const sendEmailOtp = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, message: "A valid email is required." });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await PartnerUser.findOne({ email: normalizedEmail });

    if (existingUser) {
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }

    // "trust proxy" is set in index.js, so req.ip is the real client IP
    // behind the host's proxy rather than a spoofable header.
    const ipHash = hashValue(req.ip || req.socket?.remoteAddress || "unknown");

    try {
      await enforceOtpRequestLimit({ email: normalizedEmail, ipHash });
    } catch (limitError) {
      if (!limitError.status) throw limitError;
      return res.status(limitError.status).json({ success: false, message: limitError.message });
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    const now = new Date();

    const emailRecord = await EmailOtp.findOne({ email: normalizedEmail });
    const emailWindowActive = Boolean(emailRecord?.firstRequestAt) &&
      now.getTime() - new Date(emailRecord.firstRequestAt).getTime() < OTP_RATE_LIMIT_WINDOW_MS;

    await EmailOtp.findOneAndUpdate(
      { email: normalizedEmail },
      {
        email: normalizedEmail,
        ipHash,
        otpHash: hashOtp(otp),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
        attempts: 0,
        verified: false,
        verificationToken: undefined,
        verifiedAt: undefined,
        firstRequestAt: emailWindowActive ? emailRecord.firstRequestAt : now,
        requestCount: emailWindowActive ? (emailRecord.requestCount || 0) + 1 : 1,
        lastSentAt: now
      },
      { upsert: true }
    );

    const ipRateLimit = await OtpRateLimit.findOne({ key: ipHash, kind: "ip" });
    const ipWindowActive = Boolean(ipRateLimit?.windowStart) &&
      now.getTime() - new Date(ipRateLimit.windowStart).getTime() < OTP_RATE_LIMIT_WINDOW_MS;

    await OtpRateLimit.findOneAndUpdate(
      { key: ipHash, kind: "ip" },
      {
        key: ipHash,
        kind: "ip",
        count: ipWindowActive ? (ipRateLimit.count || 0) + 1 : 1,
        windowStart: ipWindowActive ? ipRateLimit.windowStart : now,
        lastRequestedAt: now
      },
      { upsert: true }
    );

    await sendMail({
      to: normalizedEmail,
      subject: "Your SPOTX Partner verification code",
      text: `Your verification code is ${otp}. It expires in 10 minutes.`,
      html: `
        <p>Your SPOTX Partner verification code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">${otp}</p>
        <p>This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
      `
    });

    return res.json({ success: true, message: "OTP sent to your email." });
  } catch (error) {
    console.error("sendEmailOtp error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong sending the OTP." });
  }
};

const verifyEmailOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "Email and OTP are required." });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const record = await EmailOtp.findOne({ email: normalizedEmail });

    if (!record || record.expiresAt < new Date()) {
      return res.status(400).json({ success: false, message: "This OTP has expired. Request a new one." });
    }

    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      return res.status(429).json({ success: false, message: "Too many incorrect attempts. Request a new OTP." });
    }

    if (record.otpHash !== hashOtp(String(otp).trim())) {
      record.attempts += 1;
      await record.save();
      return res.status(400).json({ success: false, message: "Incorrect OTP." });
    }

    const verificationToken = crypto.randomBytes(24).toString("hex");

    record.verified = true;
    record.verificationToken = verificationToken;
    record.verifiedAt = new Date();
    await record.save();

    return res.json({ success: true, message: "Email verified.", verificationToken });
  } catch (error) {
    console.error("verifyEmailOtp error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong verifying the OTP." });
  }
};

// =====================================================
// REGISTER PARTNER
// =====================================================

const registerPartner = async (req, res) => {
  try {
    const {
      partnerType,
      contactName, email, phone,
      password,
      emailVerificationToken
    } = req.body;

    // Everything else (business name, legal details, address) is filled in
    // later from the Profile page — see partnerProfileController.updateProfile
    // — and the partner's Dashboard/Profile flag the account as incomplete
    // until they do.
    if (!partnerType || !contactName || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Partner type, name, email and phone are required."
      });
    }

    if (!password || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password is required and must contain at least 8 characters."
      });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const otpRecord = await EmailOtp.findOne({ email: normalizedEmail, verified: true });

    if (
      !otpRecord ||
      !emailVerificationToken ||
      otpRecord.verificationToken !== emailVerificationToken ||
      Date.now() - otpRecord.verifiedAt.getTime() > OTP_VERIFIED_GRACE_MS
    ) {
      return res.status(400).json({ success: false, message: "Please verify your email with the OTP before registering." });
    }

    const existingUser = await PartnerUser.findOne({ email: normalizedEmail });

    if (existingUser) {
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }

    const partnerCode = generatePartnerCode();

    // Vendor partners don't get their referral code yet — for Vendor this
    // field means "customer signup code" and is only generated once SPOTX
    // verifies the partner's documents + bank account (see
    // adminPartnerController.updatePartnerStatus). Every other partner type
    // keeps the existing behavior: a partner-referring-partner code, issued
    // immediately at registration.
    let referralCode;

    if (partnerType !== "vendor") {
      // Only 4 characters wide (~1.1M combinations) — check for a
      // collision before committing to one instead of relying on the
      // unique index to reject it after the fact.
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = generateReferralCode();
        // eslint-disable-next-line no-await-in-loop
        const taken = await Partner.exists({ "referral.referralCode": candidate });
        if (!taken) {
          referralCode = candidate;
          break;
        }
      }

      if (!referralCode) {
        return res.status(500).json({
          success: false,
          message: "Could not generate a unique referral code right now. Please try again."
        });
      }
    }

    const partner = await Partner.create({
      partnerCode,
      partnerType,
      primaryContact: { name: contactName, email: email.toLowerCase().trim(), phone },
      referral: referralCode
        ? {
            referralCode,
            referralLink: `${process.env.CLIENT_URL || "http://localhost:5173"}/partner/register?ref=${referralCode}`
          }
        : undefined,
      verification: { overallStatus: "not_submitted" },
      status: "draft"
    });

    const passwordHash = await bcrypt.hash(password, 12);

    const partnerUser = await PartnerUser.create({
      partnerId: partner._id,
      name: contactName,
      email: email.toLowerCase().trim(),
      phone: phone || "",
      role: "owner",
      permissions: ROLE_PERMISSIONS.owner,
      auth: { provider: "email", passwordHash },
      status: "active"
    });

    // Single-use — consumed now that registration succeeded.
    await EmailOtp.deleteOne({ email: normalizedEmail });

    await logActivity({
      partnerId: partner._id,
      performedByType: "partner_user",
      performedByUserId: partnerUser._id,
      activityType: "status_changed",
      entityType: "Partner",
      entityId: partner._id,
      description: "Partner account registered successfully.",
      req
    });

    await notifyAdmins({
      type: "partner_registered",
      title: `New ${partner.partnerType} registered`,
      message: `${partner.primaryContact?.name || partnerUser.name} (${partner.partnerCode}) signed up as ${["vendor", "reseller"].includes(partner.partnerType) ? "a" : "an"} ${partner.partnerType}. They'll submit KYC documents and bank details next.`,
      link: `/admin/partners/${partner._id}`,
      audienceRoles: ["kyc_reviewer"],
      partnerId: partner._id,
      entityType: "Partner",
      entityId: partner._id
    });

    // A signup bonus isn't tied to a deal, so it doesn't flow through the
    // commission engine — just flag it for an admin to settle manually.
    const token = generateToken(partnerUser);

    return res.status(201).json({
      success: true,
      message: "Partner registration successful.",
      token,
      partner: {
        id: partner._id,
        partnerCode: partner.partnerCode,
        businessName: partner.legalEntity.businessName,
        partnerType: partner.partnerType,
        status: partner.status,
        verificationStatus: partner.verification.overallStatus
      },
      user: { id: partnerUser._id, name: partnerUser.name, email: partnerUser.email, role: partnerUser.role, permissions: partnerUser.permissions },
      joinedProgram: null
    });
  } catch (error) {
    console.error("Partner registration error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong during registration.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};

// =====================================================
// LOGIN
// =====================================================

const loginPartner = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const user = await PartnerUser.findOne({ email: email.toLowerCase().trim() }).select("+auth.passwordHash");

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    if (user.status === "blocked") {
      return res.status(403).json({ success: false, message: "Your partner account access has been blocked." });
    }

    // Admin-invited accounts start with no password set — the partner sets
    // one via the emailed activation link (createPartner) before they can
    // log in at all.
    if (!user.auth.passwordHash) {
      return res.status(403).json({
        success: false,
        message: "Set your password first using the activation link sent to your email."
      });
    }

    const passwordMatch = await bcrypt.compare(password, user.auth.passwordHash);

    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    user.auth.lastLoginAt = new Date();
    if (user.status === "invited") user.status = "active";
    await user.save();

    const partner = await Partner.findById(user.partnerId);

    if (!partner) {
      return res.status(404).json({ success: false, message: "Partner account not found." });
    }

    await logActivity({
      partnerId: partner._id,
      performedByType: "partner_user",
      performedByUserId: user._id,
      activityType: "login",
      entityType: "PartnerUser",
      entityId: user._id,
      description: "Partner logged into the portal.",
      req
    });

    const token = generateToken(user);

    return res.json({
      success: true,
      message: "Login successful.",
      token,
      partner: {
        id: partner._id,
        partnerCode: partner.partnerCode,
        businessName: partner.legalEntity.businessName,
        partnerType: partner.partnerType,
        status: partner.status,
        verificationStatus: partner.verification.overallStatus
      },
      user: { id: user._id, name: user.name, email: user.email, role: user.role, permissions: user.permissions }
    });
  } catch (error) {
    console.error("Partner login error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong during login." });
  }
};

// =====================================================
// FORGOT / RESET PASSWORD
// Emailed via Gmail SMTP when SMTP_USER/SMTP_PASS are set in .env;
// falls back to logging the link to the console otherwise.
// =====================================================

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email is required." });
    }

    const genericResponse = {
      success: true,
      message: "If an account exists for that email, a reset link has been sent."
    };

    const user = await PartnerUser.findOne({ email: email.toLowerCase().trim() });

    if (!user) {
      return res.json(genericResponse);
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    user.auth.resetTokenHash = tokenHash;
    user.auth.resetTokenExpires = new Date(Date.now() + 30 * 60 * 1000);
    await user.save();

    const resetLink = `${process.env.CLIENT_URL || "http://localhost:5173"}/partner/reset-password/${rawToken}`;

    await sendMail({
      to: user.email,
      subject: "Reset your SPOTX Partner password",
      text: `Reset your password: ${resetLink}\n\nThis link expires in 30 minutes. If you didn't request this, ignore this email.`,
      html: `
        <p>We received a request to reset your SPOTX Partner account password.</p>
        <p><a href="${resetLink}">Reset your password</a></p>
        <p>This link expires in 30 minutes. If you didn't request this, ignore this email.</p>
      `
    });

    return res.json(genericResponse);
  } catch (error) {
    console.error("forgotPassword error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong processing the request." });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

    const user = await PartnerUser.findOne({
      $or: [
        { "auth.resetTokenHash": tokenHash, "auth.resetTokenExpires": { $gt: new Date() } },
        { "auth.invitationPendingHash": tokenHash, "auth.invitationPendingExpires": { $gt: new Date() } }
      ]
    }).select("+auth.resetTokenHash +auth.resetTokenExpires +auth.invitationPendingHash +auth.invitationPendingExpires +auth.invitationClaim +auth.invitationClaimExpires");

    if (!user) {
      return res.status(400).json({ success: false, message: "This reset link is invalid or has expired." });
    }

    user.auth.passwordHash = await bcrypt.hash(password, 12);
    user.auth.passwordSetupComplete = true;
    user.auth.invitationPendingHash = undefined;
    user.auth.invitationPendingExpires = undefined;
    user.auth.invitationClaim = undefined;
    user.auth.invitationClaimExpires = undefined;
    user.auth.resetTokenHash = undefined;
    user.auth.resetTokenExpires = undefined;
    await user.save();

    return res.json({ success: true, message: "Password reset successful. You can now log in." });
  } catch (error) {
    console.error("resetPassword error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong resetting the password." });
  }
};

module.exports = { registerPartner, loginPartner, forgotPassword, resetPassword, sendEmailOtp, verifyEmailOtp };
