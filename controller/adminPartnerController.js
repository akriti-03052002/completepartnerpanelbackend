const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const { Partner, PartnerDocument, PartnerBankAccount, PartnerUser, PartnerNotification, PartnerActivity } = require("../models/Index");
const PartnerCommissionAssignment = require("../models/PartnerCommissionAssignment");
const { generatePartnerCode, generateReferralCode } = require("../utils/generateCode");
const { ROLE_PERMISSIONS } = require("../config/roles");
const { COMMISSION_TYPES } = require("../config/constant");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");
const { assignReferralCode } = require("../services/vendorActivation");
const {
  attachPartnerAgreement, issuePartnerAgreementForAssignment, regeneratePartnerAgreement,
  AGREEMENT_SECTIONS, loadAgreementContext, resolveSectionText
} = require("../services/generatePartnerAgreement");
const { applyProfileUpdate } = require("../utils/partnerProfile");
const { refreshVendorScreenCount } = require("../services/tierAssignment");
const { getRequiredDocumentTypes, getNotApplicableDocumentTypes } = require("../utils/partnerVerification");
const { sendMail } = require("../utils/mailer");
const { holdSettlementsForPartner } = require("../utils/settlementHold");

/* ============================================================
   ADMIN — PARTNER MANAGEMENT
============================================================ */

// Admin invitations use an expiring password setup link.
const createPartner = async (req, res) => {
  try {
    const { partnerType, contactName, email, phone, password } = req.body;

    if (!partnerType || !contactName || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Partner type, name, email and phone are required."
      });
    }

    if (password && password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
    }

    const existingUser = await PartnerUser.findOne({ email: email.toLowerCase().trim() });

    if (existingUser) {
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }

    const partnerCode = generatePartnerCode();

    let referralCode;

    if (partnerType !== "vendor") {
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
        ? { referralCode, referralLink: `${process.env.CLIENT_URL || "http://localhost:5173"}/partner/register?ref=${referralCode}` }
        : undefined,
      verification: { overallStatus: "not_submitted" },
      status: "draft",
      owner: { salesUserId: req.adminUser._id }
    });

    const passwordHash = await bcrypt.hash(password || crypto.randomBytes(32).toString("hex"), 12);

    const rawToken = crypto.randomBytes(32).toString("hex");
    const partnerUser = await PartnerUser.create({
      partnerId: partner._id,
      name: contactName,
      email: email.toLowerCase().trim(),
      phone,
      role: "owner",
      permissions: ROLE_PERMISSIONS.owner,
      status: "active",
      auth: {
        provider: "email",
        passwordHash,
        passwordSetupComplete: false,
        resetTokenHash: crypto.createHash("sha256").update(rawToken).digest("hex"),
        resetTokenExpires: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });

    const setupLink = `${process.env.CLIENT_URL || "http://localhost:5173"}/partner/reset-password/${rawToken}`;
    const emailDelivery = await sendMail({
      to: partnerUser.email,
      subject: "Set up your SPOTX Partner account",
      text: `Your SPOTX Partner account is ready. Set your password here: ${setupLink}\n\nThis link expires in 24 hours.`,
      html: `<p>Your SPOTX Partner account is ready.</p><p><a href="${setupLink}">Set your password</a></p><p>This link expires in 24 hours.</p>`
    }).catch(() => ({ delivered: false }));

    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "status_changed",
      entityType: "Partner",
      entityId: partner._id,
      description: `${req.adminUser.name} created this partner account directly.`,
      req
    });

    return res.status(201).json({
      success: true,
      message: emailDelivery.delivered
        ? `Partner created. A password setup link was sent to ${partnerUser.email}.`
        : "Partner created, but the setup email could not be delivered. Check email configuration; the partner can request a new link using Forgot password.",
      data: { partner }
    });
  } catch (error) {
    console.error("createPartner error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong creating the partner." });
  }
};

const withInvitationStatus = async (partners) => {
  const pending = await PartnerUser.find({ partnerId: { $in: partners.map((partner) => partner._id) }, role: "owner", "auth.passwordSetupComplete": false }).select("partnerId").lean();
  const ids = new Set(pending.map((user) => String(user.partnerId)));
  return partners.map((partner) => ({ ...partner.toObject(), invitationPending: ids.has(String(partner._id)) }));
};

const listPartners = async (req, res) => {
  const { status, partnerType, search } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (partnerType) filter.partnerType = partnerType;
  if (typeof search === "string" && search.trim()) {
    const fields = ["legalEntity.businessName", "partnerCode", "primaryContact.name", "primaryContact.email", "primaryContact.phone", "referral.referralCode"];
    filter.$and = search.trim().split(/\s+/).map((word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { $or: fields.map((field) => ({ [field]: { $regex: escaped, $options: "i" } })) };
    });
  }
  const query = Partner.find(filter).sort({ createdAt: -1, _id: -1 });
  if (req.query.page !== undefined) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const [partners, total] = await Promise.all([query.skip((page - 1) * limit).limit(limit), Partner.countDocuments(filter)]);
    return res.json({ success: true, data: await withInvitationStatus(partners), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  }
  const partners = await query;
  return res.json({ success: true, data: await withInvitationStatus(partners) });
};

const getPartner = async (req, res) => {
  const partner = await Partner.findById(req.params.id);

  if (!partner) {
    return res.status(404).json({ success: false, message: "Partner not found." });
  }

  const [documents, bankAccount, team, activity] = await Promise.all([
    PartnerDocument.find({ partnerId: partner._id }).sort({ createdAt: -1 }),
    PartnerBankAccount.findOne({ partnerId: partner._id }),
    PartnerUser.find({ partnerId: partner._id }),
    PartnerActivity.find({ partnerId: partner._id }).sort({ createdAt: -1 }).limit(30)
  ]);

  return res.json({
    success: true,
    data: {
      partner,
      documents,
      requiredDocumentTypes: getRequiredDocumentTypes(partner.partnerType),
      notApplicableDocumentTypes: getNotApplicableDocumentTypes(partner.partnerType),
      bankAccount: bankAccount
        ? {
            id: bankAccount._id,
            accountHolderName: bankAccount.accountHolderName,
            bankName: bankAccount.bankName,
            accountNumberLast4: bankAccount.accountNumberLast4,
            ifscMasked: bankAccount.ifscMasked,
            verification: bankAccount.verification,
            razorpayCheck: bankAccount.razorpayCheck,
            commissionEligibility: bankAccount.commissionEligibility
          }
        : null,
      team,
      activity
    }
  });
};

const updatePartnerStatus = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;
    const validStatuses = ["draft", "pending_verification", "under_review", "active", "suspended", "rejected", "inactive"];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: "Invalid status." });
    }

    const partner = await Partner.findById(req.params.id);

    if (!partner) {
      return res.status(404).json({ success: false, message: "Partner not found." });
    }

    partner.status = status;

    let generatedReferralCode = null;

    if (status === "active") {
      partner.verification.overallStatus = "verified";
      partner.verification.verifiedBy = req.adminUser._id;
      partner.verification.verifiedAt = new Date();

      // Vendor's customer-signup code — normally auto-generated the moment
      // documents + bank verification both complete (see
      // autoActivateVendorIfVerified). This is the manual-override path:
      // an admin activating a vendor by hand still gets one too.
      if (partner.partnerType === "vendor" && !partner.referral?.referralCode) {
        generatedReferralCode = await assignReferralCode(partner);
      }
    }

    if (status === "rejected") {
      partner.verification.overallStatus = "rejected";
      partner.verification.rejectionReason = rejectionReason || "";
    }

    await partner.save();

    // Commission stays recorded — only the payout is paused. Reactivating
    // the partner later doesn't auto-release these; the release endpoint's
    // objective check (partner must be active again) already gates it, and
    // an admin still confirms each one on the way back out.
    if (status === "suspended") {
      await holdSettlementsForPartner(partner._id, {
        code: "partner_suspended",
        reason: "Partner account was suspended.",
        byUserId: req.adminUser._id,
        req
      });
    }

    if (status === "under_review") {
      await holdSettlementsForPartner(partner._id, {
        code: "compliance_review",
        reason: "Partner account is under compliance review.",
        byUserId: req.adminUser._id,
        req
      });
    }

    if (status === "active") {
      if (partner.partnerType === "vendor") {
        // Commission terms are assigned separately for this vendor.
        await refreshVendorScreenCount(partner);
      } else {
        // Every other partner type still gets one immediately on activation.
        await attachPartnerAgreement(partner, req.adminUser._id);
      }
    }

    if (generatedReferralCode) {
      await PartnerNotification.create({
        partnerId: partner._id,
        type: "referral_code_generated",
        title: "Your customer referral code is ready",
        message: `Your account is verified. Share code ${generatedReferralCode} with customers so they can register under you.`,
        entity: { type: "Partner", entityId: partner._id }
      });
    }

    if (status === "rejected") {
      await PartnerNotification.create({
        partnerId: partner._id,
        type: "partner_rejected",
        title: "Your partner account was rejected",
        message: rejectionReason
          ? `Your partner account was rejected: ${rejectionReason}`
          : "Your partner account was rejected. Contact SPOTX support for details.",
        entity: { type: "Partner", entityId: partner._id }
      });
    }

    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "status_changed",
      entityType: "Partner",
      entityId: partner._id,
      description: `${req.adminUser.name} changed partner status to ${status}.`,
      req
    });

    // Rejection and a freshly minted referral code are announced above;
    // every other status change is told to the partner here.
    const STATUS_NOTICE = {
      active: ["Your partner account is active", "SPOTX has activated your partner account. All features are available."],
      suspended: ["Your partner account was suspended", "SPOTX has suspended your partner account. Features that need a verified account are locked and payouts are on hold until it is reactivated."],
      under_review: ["Your partner account is under review", "SPOTX is reviewing your partner account. You'll be notified when the review is complete."],
      inactive: ["Your partner account was made inactive", "SPOTX has marked your partner account inactive. Contact SPOTX if you think this is a mistake."],
      pending_verification: ["Your partner account is pending verification", "Your partner account is waiting for SPOTX to verify your documents and bank account."]
    };
    if (STATUS_NOTICE[status] && !(status === "active" && generatedReferralCode)) {
      await notifyPartner({
        partnerId: partner._id,
        type: "partner_status_changed",
        title: STATUS_NOTICE[status][0],
        message: STATUS_NOTICE[status][1],
        entityType: "Partner",
        entityId: partner._id
      });
    }

    return res.json({ success: true, message: "Partner status updated.", data: partner });
  } catch (error) {
    console.error("updatePartnerStatus error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong updating the partner." });
  }
};

const assignTier = async (req, res) => {
  try {
    const { tierId } = req.body;

    const partner = await Partner.findById(req.params.id);

    if (!partner) {
      return res.status(404).json({ success: false, message: "Partner not found." });
    }

    if (partner.partnerType === "vendor") {
      return res.status(400).json({ success: false, message: "Vendors use individual commission assignments, not tiers." });
    }

    partner.program.tierId = tierId || undefined;
    partner.program.tierAssignedAt = new Date();
    partner.program.tierAssignmentMode = "manual";

    await partner.save();

    // Tier is now purely a categorization/perks ladder — it no longer
    // triggers the agreement by itself. For vendors, the agreement is
    // generated by assignCustomCommission below once the admin explicitly
    // sets a commission type + amount for this specific partner.

    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "tier_changed",
      entityType: "Partner",
      entityId: partner._id,
      description: `${req.adminUser.name} assigned a new tier.`,
      req
    });

    await notifyPartner({
      partnerId: partner._id,
      type: "tier_changed",
      title: "Your partner tier changed",
      message: "SPOTX updated your partner tier. See your Dashboard for what it means for you.",
      entityType: "Partner",
      entityId: partner._id
    });

    return res.json({ success: true, message: "Tier assigned.", data: partner });
  } catch (error) {
    console.error("assignTier error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong assigning the tier." });
  }
};

// Vendor-only: a custom, per-partner commission set directly by the
// admin (type + rate/amount) — independent of the shared tier ladder.
// Setting this is what actually generates the Partner Agreement: any
// prior assignment is superseded (kept on record, not deleted — see the
// model), a fresh assignment is created, and a reissued agreement is
// immediately filed and auto-accepted on the partner's behalf.
const assignCustomCommission = async (req, res) => {
  try {
    const {
      commissionType, rate, fixedAmount, perScreenAmount, hybrid,
      calculationBase, recurring, minimumSettlementAmount, notes
    } = req.body;

    if (!COMMISSION_TYPES.includes(commissionType)) {
      return res.status(400).json({ success: false, message: "A valid commission type is required." });
    }

    const partner = await Partner.findById(req.params.id);
    if (!partner) {
      return res.status(404).json({ success: false, message: "Partner not found." });
    }

    if (partner.partnerType !== "vendor") {
      return res.status(400).json({ success: false, message: "Custom commission assignment is only available for vendor partners." });
    }

    await PartnerCommissionAssignment.updateMany(
      { partnerId: partner._id, status: "active" },
      { $set: { status: "superseded" } }
    );

    const assignment = await PartnerCommissionAssignment.create({
      partnerId: partner._id,
      commissionType,
      rate: rate || 0,
      fixedAmount: fixedAmount || 0,
      perScreenAmount: perScreenAmount || 0,
      hybrid: hybrid || undefined,
      calculationBase: calculationBase || "net_revenue",
      recurring: recurring || undefined,
      minimumSettlementAmount: minimumSettlementAmount || 0,
      notes: notes || "",
      status: "active",
      assignedBy: req.adminUser._id,
      assignedAt: new Date()
    });

    const { document, acceptance } = await issuePartnerAgreementForAssignment(partner, assignment, req.adminUser._id);

    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      // Closest fit in PartnerActivity's fixed enum (a model, can't be
      // extended) — same convention used elsewhere in this codebase for
      // events without a dedicated activityType value.
      activityType: "tier_changed",
      entityType: "Partner",
      entityId: partner._id,
      description: `${req.adminUser.name} set this partner's commission (${commissionType}) and issued agreement ${acceptance.agreementRef}.`,
      req
    });

    await PartnerNotification.create({
      partnerId: partner._id,
      type: "partner_agreement_issued",
      title: "Your commission terms are set",
      message: `SPOTX has set your commission terms. Your Partner Agreement (${acceptance.agreementRef}) has been generated and is automatically accepted.`,
      entity: { type: "Partner", entityId: partner._id }
    }).catch((error) => console.error("assignCustomCommission: notification failed:", error.message));

    return res.json({
      success: true,
      message: "Commission assigned — agreement issued and accepted.",
      data: { assignment, document, acceptance }
    });
  } catch (error) {
    console.error("assignCustomCommission error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong assigning commission." });
  }
};

const getCommissionAssignment = async (req, res) => {
  const active = await PartnerCommissionAssignment.findOne({ partnerId: req.params.id, status: "active" }).sort({ assignedAt: -1 });
  const history = await PartnerCommissionAssignment.find({ partnerId: req.params.id }).sort({ assignedAt: -1 });
  return res.json({ success: true, data: { active: active || null, history } });
};

/* Admin edits a partner's business / contact / address details — the same
   fields the partner edits on their own Profile page. */
const updatePartnerProfile = async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ success: false, message: "Partner not found." });

    applyProfileUpdate(partner, req.body);
    await partner.save();

    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "Partner",
      entityId: partner._id,
      description: `${req.adminUser.name} updated the partner's profile details.`,
      req
    });

    await notifyPartner({
      partnerId: partner._id,
      type: "profile_updated_by_admin",
      title: "SPOTX updated your profile details",
      message: "SPOTX edited your business, contact or address details. Check your Profile and tell SPOTX if anything is wrong.",
      entityType: "Partner",
      entityId: partner._id
    });

    return res.json({ success: true, message: "Partner details saved.", data: partner });
  } catch (error) {
    console.error("updatePartnerProfile error:", error);
    return res.status(400).json({ success: false, message: error.message || "Something went wrong saving the details." });
  }
};

const TEAM_ROLES = ["admin", "sales", "finance", "viewer"];

// Change a team member's role, or block / unblock their login. The owner
// account can't be changed here, so a partner is never left without one.
const updateTeamMember = async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ success: false, message: "Partner not found." });

    if (partner.partnerType === "influencer") {
      return res.status(403).json({ success: false, message: "Team is not available for influencer partners." });
    }

    const member = await PartnerUser.findOne({ _id: req.params.userId, partnerId: partner._id });
    if (!member) return res.status(404).json({ success: false, message: "Team member not found." });

    if (member.role === "owner") {
      return res.status(400).json({ success: false, message: "The owner account can't be changed or blocked." });
    }

    const { role, status } = req.body;
    const changes = [];

    if (role !== undefined && role !== member.role) {
      if (!TEAM_ROLES.includes(role)) return res.status(400).json({ success: false, message: "Invalid role." });
      member.role = role;
      member.permissions = ROLE_PERMISSIONS[role];
      changes.push(`role to ${role}`);
    }
    if (status !== undefined && status !== member.status) {
      if (!["active", "blocked"].includes(status)) return res.status(400).json({ success: false, message: "Invalid status." });
      member.status = status;
      changes.push(status === "blocked" ? "blocked their login" : "unblocked their login");
    }

    if (changes.length === 0) return res.json({ success: true, message: "Nothing to change.", data: member });

    await member.save();
    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "PartnerUser",
      entityId: member._id,
      description: `${req.adminUser.name} changed ${member.name}: ${changes.join(", ")}.`,
      req
    });

    await notifyPartner({
      partnerId: partner._id,
      type: "team_member_updated",
      title: "SPOTX changed a team member",
      message: `SPOTX changed ${member.name}: ${changes.join(", ")}.`,
      entityType: "PartnerUser",
      entityId: member._id
    });

    return res.json({ success: true, message: "Team member updated.", data: member });
  } catch (error) {
    console.error("updateTeamMember error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong updating the team member." });
  }
};

/* ============================================================
   PER-PARTNER AGREEMENT TERMS
   Vendor / Affiliate / Reseller agreements are built from the sections
   in services/generatePartnerAgreement.js, each of which can be
   overridden for one partner. Influencer agreements instead come from
   the shared template edited at /admin/agreement.
============================================================ */

const INFLUENCER_TERMS_MESSAGE = "Influencer agreements use the shared Influencer Agreement template — edit it under Influencer Agreement instead.";

const getAgreementTerms = async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ success: false, message: "Partner not found." });
    if (partner.partnerType === "influencer") {
      return res.status(400).json({ success: false, message: INFLUENCER_TERMS_MESSAGE });
    }

    const context = await loadAgreementContext(partner);
    const sections = AGREEMENT_SECTIONS.map((section) => ({
      key: section.key,
      title: section.title(partner),
      value: resolveSectionText(partner, section, context),
      isCustomized: Boolean(partner.agreementTerms?.[section.key]?.trim?.())
    }));

    return res.json({ success: true, data: { sections } });
  } catch (error) {
    console.error("getAgreementTerms error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong loading the agreement terms." });
  }
};

// Saves per-partner overrides only — doesn't touch any agreement PDF
// already on file. An admin calls regenerateAgreement separately to
// reissue it with the new text; the agreement is a legal document already
// in the partner's document list, so reissuing is a deliberate action.
// Saving a section as blank clears its override (back to the default).
const updateAgreementTerms = async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ success: false, message: "Partner not found." });
    if (partner.partnerType === "influencer") {
      return res.status(400).json({ success: false, message: INFLUENCER_TERMS_MESSAGE });
    }

    const validKeys = new Set(AGREEMENT_SECTIONS.map((section) => section.key));
    const next = { ...(partner.agreementTerms || {}) };

    for (const [key, value] of Object.entries(req.body.sections || {})) {
      if (!validKeys.has(key) || typeof value !== "string") continue;
      if (value.length > 10000) {
        return res.status(400).json({ success: false, message: "An agreement section can't be longer than 10,000 characters." });
      }
      next[key] = value;
    }

    partner.agreementTerms = next;
    partner.markModified("agreementTerms");
    await partner.save();

    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "agreement_terms_updated",
      entityType: "Partner",
      entityId: partner._id,
      description: `${req.adminUser.name} updated this partner's agreement terms.`,
      req
    });

    return res.json({ success: true, message: "Agreement terms saved." });
  } catch (error) {
    console.error("updateAgreementTerms error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong saving the agreement terms." });
  }
};

// Reissues the agreement PDF from the partner's current terms (including
// any overrides just saved). The new document sits alongside earlier
// versions — the admin/partner UIs already show the latest.
const regenerateAgreement = async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner) return res.status(404).json({ success: false, message: "Partner not found." });

    const document = await regeneratePartnerAgreement(partner, req.adminUser._id);

    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "agreement_regenerated",
      entityType: "Partner",
      entityId: partner._id,
      description: `${req.adminUser.name} reissued this partner's agreement.`,
      req
    });

    await PartnerNotification.create({
      partnerId: partner._id,
      type: "agreement_reissued",
      title: "Your partner agreement was reissued",
      message: "SPOTX reissued your partner agreement with updated terms. You can view it under Documents.",
      entity: { type: "PartnerDocument", entityId: document._id }
    });

    return res.json({ success: true, message: "Agreement reissued.", data: document });
  } catch (error) {
    console.error("regenerateAgreement error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong reissuing the agreement." });
  }
};

module.exports = {
  createPartner, listPartners, getPartner, updatePartnerStatus, assignTier,
  assignCustomCommission, getCommissionAssignment,
  updatePartnerProfile, updateTeamMember,
  getAgreementTerms, updateAgreementTerms, regenerateAgreement
};
const resendInvitation = async (req, res) => {
  try {
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const claim = crypto.randomUUID();
    const now = new Date();
    const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const user = await PartnerUser.findOneAndUpdate({
      partnerId: req.params.id, role: "owner", "auth.passwordSetupComplete": false,
      $and: [
        { $or: [{ "auth.invitationClaimExpires": { $lte: now } }, { "auth.invitationClaimExpires": { $exists: false } }] },
        { $or: [{ "auth.resetTokenExpires": { $lte: new Date(expires.getTime() - 60000) } }, { "auth.resetTokenExpires": { $exists: false } }] }
      ]
    }, { $set: { "auth.invitationClaim": claim, "auth.invitationClaimExpires": new Date(now.getTime() + 5 * 60000), "auth.invitationPendingHash": tokenHash, "auth.invitationPendingExpires": expires } }, { returnDocument: "after" });
    if (!user) {
      const pending = await PartnerUser.exists({ partnerId: req.params.id, role: "owner", "auth.passwordSetupComplete": false });
      return res.status(pending ? 429 : 400).json({ success: false, message: pending ? "Wait one minute before resending, or wait for the current delivery to finish." : "This partner has no pending invitation." });
    }
    const link = `${process.env.CLIENT_URL || "http://localhost:5173"}/partner/reset-password/${rawToken}`;
    const delivery = await sendMail({ to: user.email, subject: "Set up your SPOTX Partner account", text: `Set your password: ${link}\nThis link expires in 24 hours.` }).catch(() => ({ delivered: false }));
    const unset = { "auth.invitationClaim": 1, "auth.invitationClaimExpires": 1, "auth.invitationPendingHash": 1, "auth.invitationPendingExpires": 1 };
    const updated = await PartnerUser.findOneAndUpdate({ _id: user._id, "auth.invitationClaim": claim, "auth.passwordSetupComplete": false }, {
      ...(delivery.delivered ? { $set: { "auth.resetTokenHash": tokenHash, "auth.resetTokenExpires": expires } } : {}), $unset: unset
    });
    if (!delivery.delivered) return res.status(503).json({ success: false, message: "Email delivery is unavailable. The previous setup link remains valid." });
    if (!updated) return res.status(409).json({ success: false, message: "Password setup already completed or the invitation changed." });
    await logActivity({ partnerId: user.partnerId, performedByType: "spotx_user", performedByUserId: req.adminUser._id, activityType: "note", entityType: "Partner", entityId: user.partnerId, description: `${req.adminUser.name} resent the password setup invitation.`, req });
    return res.json({ success: true, message: "Password setup invitation resent." });
  } catch {
    return res.status(500).json({ success: false, message: "Could not resend the invitation." });
  }
};
module.exports.resendInvitation = resendInvitation;
