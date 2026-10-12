const { PartnerDocument, PartnerBankAccount } = require("../models/Index");

/**
 * Which KYC documents are compulsory before a partner can be verified,
 * per partnerType. Business-entity types (Vendor, Reseller, Agency,
 * Technology, Strategic) need full business KYC since they invoice SPOTX
 * and move real commercial volume. Individual-oriented types (Affiliate,
 * Influencer, Referral) are frequently a single person, not a registered
 * company — GST registration and MSME/Udyam registration usually don't
 * even apply to them, so requiring those would block legitimate signups.
 * PAN and a cancelled cheque stay required everywhere: PAN is universal
 * in India (individual or business), and a cheque is how anyone gets paid.
 *
 * This is the one place that decides what's compulsory — Documents.jsx
 * (partner-facing checklist) and this file's isPartnerFullyVerified
 * (the activation gate) both read from it, so they can never disagree.
 */
const REQUIRED_DOCUMENTS_BY_PARTNER_TYPE = {
  vendor: ["msme_udyam", "gst_certificate", "pan_card", "cancelled_cheque"],
  reseller: ["msme_udyam", "gst_certificate", "pan_card", "cancelled_cheque"],
  agency: ["msme_udyam", "gst_certificate", "pan_card", "cancelled_cheque"],
  technology: ["msme_udyam", "gst_certificate", "pan_card", "cancelled_cheque"],
  strategic: ["msme_udyam", "gst_certificate", "pan_card", "cancelled_cheque"],
  affiliate: ["pan_card", "cancelled_cheque"],
  influencer: ["pan_card", "cancelled_cheque"],
  referral: ["pan_card", "cancelled_cheque"]
};

/**
 * Business registration documents (GST, MSME / Udyam) by partner type:
 *   Vendor, Reseller -> compulsory (they are in the required list above)
 *   Affiliate        -> optional: may upload them, never needed to be verified
 *   Influencer       -> not applicable at all: an influencer is an individual,
 *                       not a business, so these are neither asked for nor accepted
 */
const NOT_APPLICABLE_DOCUMENTS_BY_PARTNER_TYPE = {
  influencer: ["msme_udyam", "gst_certificate"]
};

const getNotApplicableDocumentTypes = (partnerType) => NOT_APPLICABLE_DOCUMENTS_BY_PARTNER_TYPE[partnerType] || [];

const isDocumentTypeApplicable = (partnerType, documentType) => !getNotApplicableDocumentTypes(partnerType).includes(documentType);

const getRequiredDocumentTypes = (partnerType) =>
  REQUIRED_DOCUMENTS_BY_PARTNER_TYPE[partnerType] || REQUIRED_DOCUMENTS_BY_PARTNER_TYPE.vendor;

const latestDocumentsByType = (documents) => {
  const latest = new Map();
  for (const document of [...documents].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0) || String(b._id || "").localeCompare(String(a._id || "")))) {
    if (!latest.has(document.documentType)) latest.set(document.documentType, document);
  }
  return latest;
};

const computeKycStatus = (documents, partnerType) => {
  const latest = latestDocumentsByType(documents);
  const required = getRequiredDocumentTypes(partnerType).map(type => latest.get(type));
  if (required.some(document => document?.verification?.status === "rejected")) return "rejected";
  if (required.some(document => !document)) return "not_submitted";
  if (required.every(document => document.verification?.status === "verified")) return "verified";
  return "pending";
};

/**
 * Default label for the partner's primary performance metric, used when
 * they don't yet have a tier assigned (PartnerTier.qualification.metric.label
 * is the source of truth once a tier exists — see Partnertier.js). Vendor is
 * the only type whose business is literally screens; everyone else refers
 * leads/deals toward the same underlying SPOTX signage sale.
 */
const DEFAULT_METRIC_LABEL_BY_PARTNER_TYPE = {
  vendor: "Referred Screens",
  affiliate: "Leads Referred",
  influencer: "Leads Referred",
  referral: "Introductions Made",
  reseller: "Volume Purchased",
  agency: "Deals Referred",
  technology: "Deals Referred",
  strategic: "Deals Referred"
};

const getDefaultMetricLabel = (partnerType) =>
  DEFAULT_METRIC_LABEL_BY_PARTNER_TYPE[partnerType] || DEFAULT_METRIC_LABEL_BY_PARTNER_TYPE.vendor;

const isKycDocumentsVerified = async (partnerId, partnerType) => {
  const requiredTypes = getRequiredDocumentTypes(partnerType);

  const documents = await PartnerDocument.find({ partnerId, documentType: { $in: requiredTypes } });

  return computeKycStatus(documents, partnerType) === "verified";
};

const isPartnerFullyVerified = async (partnerId, partnerType) => {
  const [allDocsVerified, bankAccount] = await Promise.all([
    isKycDocumentsVerified(partnerId, partnerType),
    PartnerBankAccount.findOne({ partnerId })
  ]);

  const bankVerified = bankAccount?.verification?.status === "verified";

  return allDocsVerified && bankVerified;
};

/**
 * Registration only collects name, email, phone and type; the business (or
 * creator) name is filled in afterwards from Profile, so every type is
 * incomplete without it. Influencers additionally need their state and
 * city — their agreement is issued to them as an individual at that
 * address.
 */
const isProfileComplete = (partner) => {
  const hasName = Boolean(partner?.legalEntity?.businessName);
  if (partner?.partnerType !== "influencer") return hasName;
  return hasName && Boolean(partner?.address?.state && partner?.address?.city);
};

module.exports = {
  latestDocumentsByType,
  computeKycStatus,
  isProfileComplete,
  getNotApplicableDocumentTypes,
  isDocumentTypeApplicable,
  isPartnerFullyVerified,
  isKycDocumentsVerified,
  getRequiredDocumentTypes,
  REQUIRED_DOCUMENTS_BY_PARTNER_TYPE,
  getDefaultMetricLabel
};
