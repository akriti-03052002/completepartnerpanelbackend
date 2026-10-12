const { getRequiredDocumentTypes, latestDocumentsByType } = require("./partnerVerification");

const filled = value => typeof value === "string" && Boolean(value.trim());
const summarize = checks => ({
  completed: checks.filter(check => check.done).length,
  total: checks.length,
  percent: Math.round(checks.filter(check => check.done).length / checks.length * 100)
});

function partnerCompletion(partner, documents = [], bank = null) {
  const profileFields = [
    ["Business / creator name", partner.legalEntity?.businessName],
    ["Contact name", partner.primaryContact?.name],
    ["Email", partner.primaryContact?.email],
    ["Phone", partner.primaryContact?.phone],
    ["Country", partner.address?.country],
    ["State", partner.address?.state],
    ["City", partner.address?.city],
    ["Address", partner.address?.addressLine1],
    ["Postal code", partner.address?.pincode]
  ];
  const profileChecks = profileFields.map(([label, value]) => ({ label, done: filled(value) }));
  const latest = latestDocumentsByType(documents);
  const checks = getRequiredDocumentTypes(partner.partnerType).map(type => {
    const document = latest.get(type);
    return { done: Boolean(document?.file?.objectKey) && document.verification?.status !== "rejected", verified: document?.verification?.status === "verified" };
  });
  checks.push({ done: Boolean(bank?.accountHolderName && bank?.bankName && bank?.accountNumberLast4) && bank.verification?.status !== "rejected", verified: bank?.verification?.status === "verified" });
  return {
    profile: { ...summarize(profileChecks), missing: profileChecks.filter(check => !check.done).map(check => check.label) },
    documentsAndBank: { ...summarize(checks), verified: checks.filter(check => check.done && check.verified).length }
  };
}
module.exports = partnerCompletion;
