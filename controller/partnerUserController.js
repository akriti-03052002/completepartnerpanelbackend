const crypto = require("crypto");
const { PartnerUser } = require("../models/Index");
const { ROLE_PERMISSIONS, OWNER_ONLY_PERMISSIONS } = require("../config/roles");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");
const { sendMail } = require("../utils/mailer");

// Strips document/bank permissions from any custom set — those stay
// owner-only no matter what a request body tries to grant.
const sanitizePermissions = (permissions) => permissions.filter((p) => !OWNER_ONLY_PERMISSIONS.includes(p));

/* ============================================================
   TEAM MANAGEMENT
   Owner/admin invite teammates under their partner account and
   assign roles. Permissions are auto-filled from the role
   template but can be overridden afterwards.
============================================================ */

const listTeam = async (req, res) => {
  const team = await PartnerUser.find({ partnerId: req.partner._id }).sort({ createdAt: -1 });

  return res.json({ success: true, data: team });
};

const inviteTeamMember = async (req, res) => {
  try {
    const { name, email, phone, role } = req.body;

    if (!name || !email || !role) {
      return res.status(400).json({
        success: false,
        message: "Name, email and role are required."
      });
    }

    if (!ROLE_PERMISSIONS[role]) {
      return res.status(400).json({ success: false, message: "Invalid role." });
    }

    if (role === "owner") {
      return res.status(400).json({
        success: false,
        message: "A partner account can only have one owner (set at registration)."
      });
    }

    const existing = await PartnerUser.findOne({ email: email.toLowerCase().trim() });

    if (existing) {
      return res.status(409).json({ success: false, message: "An account with this email already exists." });
    }

    // No password is set here — the teammate gets an emailed link to set
    // their own (same reset-token mechanism as partnerAuthController's
    // forgotPassword/resetPassword). loginPartner blocks login until then
    // and flips status to "active" on their first successful login.
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const teamMember = await PartnerUser.create({
      partnerId: req.partner._id,
      name,
      email: email.toLowerCase().trim(),
      phone: phone || "",
      role,
      permissions: sanitizePermissions(ROLE_PERMISSIONS[role]),
      auth: {
        provider: "email",
        resetTokenHash: tokenHash,
        resetTokenExpires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      },
      status: "invited"
    });

    const activationLink = `${process.env.CLIENT_URL || "http://localhost:5173"}/partner/reset-password/${rawToken}`;
    const businessName = req.partner.legalEntity?.businessName || "your team";

    await sendMail({
      to: teamMember.email,
      subject: `You've been invited to join ${businessName} on SPOTX Partner Panel`,
      text: `${req.partnerUser.name} invited you to join ${businessName} as ${role}. Set your password to activate your account: ${activationLink}\n\nThis link expires in 7 days.`,
      html: `
        <p>${req.partnerUser.name} invited you to join ${businessName} on SPOTX Partner Panel as <strong>${role}</strong>.</p>
        <p><a href="${activationLink}">Set your password to activate your account</a></p>
        <p>This link expires in 7 days.</p>
      `
    });

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "note",
      entityType: "PartnerUser",
      entityId: teamMember._id,
      description: `${req.partnerUser.name} invited ${teamMember.name} as ${role}.`,
      req
    });

    await notifyPartner({
      partnerId: req.partner._id,
      type: "team_member_invited",
      title: "Team member invited",
      message: `${req.partnerUser.name} invited ${teamMember.name} (${teamMember.email}) as ${teamMember.role}.`,
      entityType: "PartnerUser",
      entityId: teamMember._id
    });

    return res.status(201).json({
      success: true,
      message: `Invite sent to ${teamMember.email}.`,
      data: { id: teamMember._id, name: teamMember.name, email: teamMember.email, role: teamMember.role }
    });
  } catch (error) {
    console.error("inviteTeamMember error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong inviting the team member." });
  }
};

const updateTeamMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { role, permissions, status } = req.body;

    const teamMember = await PartnerUser.findOne({ _id: id, partnerId: req.partner._id });

    if (!teamMember) {
      return res.status(404).json({ success: false, message: "Team member not found." });
    }

    if (teamMember.role === "owner") {
      return res.status(400).json({ success: false, message: "The owner's role cannot be changed here." });
    }

    if (role) {
      if (!ROLE_PERMISSIONS[role] || role === "owner") {
        return res.status(400).json({ success: false, message: "Invalid role." });
      }
      teamMember.role = role;
      teamMember.permissions = sanitizePermissions(permissions || ROLE_PERMISSIONS[role]);
    } else if (permissions) {
      teamMember.permissions = sanitizePermissions(permissions);
    }

    if (status && ["active", "invited", "blocked"].includes(status)) {
      teamMember.status = status;
    }

    await teamMember.save();

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "note",
      entityType: "PartnerUser",
      entityId: teamMember._id,
      description: `${req.partnerUser.name} updated ${teamMember.name}'s access.`,
      req
    });

    return res.json({ success: true, message: "Team member updated.", data: teamMember });
  } catch (error) {
    console.error("updateTeamMember error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong updating the team member." });
  }
};

const resendTeamActivation = async (req, res) => {
  try {
    const member = await PartnerUser.findOne({ _id: req.params.id, partnerId: req.partner._id }).select("+auth.passwordHash +auth.resetTokenHash +auth.resetTokenExpires");
    if (!member) return res.status(404).json({ success: false, message: "Team member not found." });
    if (member.role === "owner" || !["invited", "active"].includes(member.status)) {
      return res.status(400).json({ success: false, message: "Password links are available for invited or active team members, except the owner. Unblock a blocked member first." });
    }
    const rawToken = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const sentAt = new Date();
    const claimed = await PartnerUser.findOneAndUpdate({
      _id: member._id, partnerId: req.partner._id, role: { $ne: "owner" }, status: { $in: ["invited", "active"] },
      $or: [{ "auth.invitationSentAt": { $exists: false } }, { "auth.invitationSentAt": { $lte: new Date(Date.now() - 60000) } }]
    }, { $set: { "auth.resetTokenHash": hash, "auth.resetTokenExpires": new Date(Date.now() + 7 * 86400000), "auth.invitationSentAt": sentAt } }, { returnDocument: "after" });
    if (!claimed) return res.status(429).json({ success: false, message: "Please wait one minute before resending the activation link." });
    try {
      const link = `${process.env.CLIENT_URL || "http://localhost:5173"}/partner/reset-password/${rawToken}`;
      await sendMail({ to: member.email, subject: member.status === "active" ? "Reset your password for SpotX Partner Panel" : "Set your password for SpotX Partner Panel", text: `${member.status === "active" ? "Reset your team account password" : "Set your password to activate your team account"}: ${link}\n\nThis link expires in 7 days and replaces the previous link. Check your spam folder if you cannot find this email.` });
    } catch (error) {
      const restore = { $unset: { "auth.invitationSentAt": 1 } };
      restore.$set = { "auth.resetTokenHash": member.auth.resetTokenHash, "auth.resetTokenExpires": member.auth.resetTokenExpires };
      await PartnerUser.updateOne({ _id: member._id, "auth.resetTokenHash": hash }, restore);
      throw error;
    }
    return res.json({ success: true, message: `Password link sent to ${member.email}. Ask them to check their inbox and spam folder.` });
  } catch (error) {
    console.error("resendTeamActivation error:", error.message);
    return res.status(500).json({ success: false, message: "Could not send the activation email. Please try again." });
  }
};

module.exports = { listTeam, inviteTeamMember, updateTeamMember, resendTeamActivation };
