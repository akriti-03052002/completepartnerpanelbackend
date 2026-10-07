const { Partner, PartnerDocument, PartnerNotification } = require("../models/Index");
module.exports = async (partnerId, adminId) => {
  if (!await PartnerDocument.exists({ partnerId, documentType: "partner_agreement" })) return null;
  const partner = await Partner.findById(partnerId);
  try {
    const document = await require("./generatePartnerAgreement").regeneratePartnerAgreement(partner, adminId);
    await PartnerNotification.create({ partnerId, type: "agreement_updated", title: "Your agreement was updated", message: "SPOTX updated your profile or payment terms and issued a new agreement version. Preview it in Documents.", entity: { type: "PartnerDocument", entityId: document._id } });
    return null;
  } catch (error) {
    console.error("Agreement refresh failed:", String(partnerId));
    return "Details were saved, but the agreement could not be updated. Reissue it from the partner profile.";
  }
};
