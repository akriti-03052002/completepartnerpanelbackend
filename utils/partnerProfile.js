/**
 * Business / contact / address fields a partner profile can be edited on.
 * Shared by the partner's own Profile page (partnerProfileController) and
 * the admin's affiliate page (adminPartnerController) so both edit the
 * same fields the same way.
 */
const PROFILE_FIELDS = {
  businessName: "legalEntity.businessName",
  legalName: "legalEntity.legalName",
  entityType: "legalEntity.entityType",
  website: "legalEntity.website",
  industry: "legalEntity.industry",
  contactName: "primaryContact.name",
  phone: "primaryContact.phone",
  designation: "primaryContact.designation",
  country: "address.country",
  state: "address.state",
  city: "address.city",
  addressLine1: "address.addressLine1",
  addressLine2: "address.addressLine2",
  pincode: "address.pincode"
};

// Blank values would break required/enum fields, so these are only
// changed when a non-empty value is sent.
const NON_BLANK = new Set(["businessName", "entityType", "contactName"]);

const applyProfileUpdate = (partner, body) => {
  for (const [key, path] of Object.entries(PROFILE_FIELDS)) {
    const value = body[key];
    if (value === undefined) continue;
    if (NON_BLANK.has(key) && !value) continue;
    partner.set(path, typeof value === "string" ? value.trim() : value);
  }
};

module.exports = { PROFILE_FIELDS, applyProfileUpdate };
