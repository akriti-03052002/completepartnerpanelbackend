const { Partner } = require("../models/Index");
const { getRequiredDocumentTypes, getNotApplicableDocumentTypes, isProfileComplete } = require("../utils/partnerVerification");

/* ============================================================
   PARTNER PROFILE
============================================================ */

const getProfile = async (req, res) => {
  const partner = req.partner.toObject();
  if (req.partnerUser.role !== "owner" && !req.partnerUser.permissions.includes("commissions:view")) {
    for (const key of ["totalCommission", "pendingCommission", "approvedCommission", "paidCommission"]) delete partner.stats[key];
  }
  return res.json({
    success: true,
    data: {
      partner,
      user: req.partnerUser,
      requiredDocumentTypes: getRequiredDocumentTypes(req.partner.partnerType),
      notApplicableDocumentTypes: getNotApplicableDocumentTypes(req.partner.partnerType),
      profileComplete: isProfileComplete(req.partner)
    }
  });
};

const updateProfile = async (req, res) => {
  try {
    const {
      businessName, legalName, entityType, website, industry,
      contactName, phone, designation,
      country, state, city, addressLine1, addressLine2, pincode
    } = req.body;

    const partner = await Partner.findById(req.partner._id);

    if (businessName) partner.legalEntity.businessName = businessName;
    if (legalName !== undefined) partner.legalEntity.legalName = legalName;
    if (entityType) partner.legalEntity.entityType = entityType;
    if (website !== undefined) partner.legalEntity.website = website;
    if (industry !== undefined) partner.legalEntity.industry = industry;

    if (contactName) partner.primaryContact.name = contactName;
    if (phone !== undefined) partner.primaryContact.phone = phone;
    if (designation !== undefined) partner.primaryContact.designation = designation;

    if (country !== undefined) partner.address.country = country;
    if (state !== undefined) partner.address.state = state;
    if (city !== undefined) partner.address.city = city;
    if (addressLine1 !== undefined) partner.address.addressLine1 = addressLine1;
    if (addressLine2 !== undefined) partner.address.addressLine2 = addressLine2;
    if (pincode !== undefined) partner.address.pincode = pincode;

    await partner.save();

    return res.json({ success: true, message: "Profile updated.", data: partner });
  } catch (error) {
    console.error("updateProfile error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong updating your profile." });
  }
};

module.exports = { getProfile, updateProfile };
