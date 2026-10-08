const { Partner, PartnerDocument, PartnerBankAccount } = require("../models/Index");
const { getRequiredDocumentTypes } = require("../utils/partnerVerification");

module.exports = async function incompletePartnerChecks(kind) {
  const partners = await Partner.find({ status: { $nin: ["rejected", "inactive"] } }, "partnerCode partnerType legalEntity.businessName primaryContact.name").lean();
  const ids = partners.map(p => p._id);
  const records = kind === "bank"
    ? await PartnerBankAccount.find({ partnerId: { $in: ids } }, "partnerId verification.status pendingChange.submittedAt").lean()
    : await PartnerDocument.find({ partnerId: { $in: ids } }, "partnerId documentType verification.status").lean();
  return partners.flatMap(partner => {
    const own = records.filter(record => String(record.partnerId) === String(partner._id));
    if (kind === "bank") {
      if (own[0]?.pendingChange) return [{ ...partner, checkStatus: "Bank update awaiting review", bankAccountId: String(own[0]._id) }];
      if (own.some(record => record.verification?.status === "verified")) return [];
      return [{ ...partner, checkStatus: !own.length ? "Not submitted" : own[0].verification?.status === "rejected" ? "Needs correction" : "Waiting for review" }];
    }
    const missing = getRequiredDocumentTypes(partner.partnerType).filter(type => !own.some(record => record.documentType === type && record.verification?.status === "verified"));
    if (!missing.length) return [];
    const awaiting = missing.some(type => own.some(record => record.documentType === type && record.verification?.status === "pending"));
    const notSubmitted = missing.filter(type => !own.some(record => record.documentType === type));
    return [{ ...partner, checkStatus: awaiting ? "Waiting for review" : notSubmitted.length ? "Not submitted" : "Needs correction", missing, notSubmitted }];
  });
};
