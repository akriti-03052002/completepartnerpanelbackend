const { PartnerDocument, PartnerBankAccount, Partner, PartnerNotification } = require("../models/Index");
const logActivity = require("../utils/logActivity");
const { storeUploadedFile, sendStoredFile } = require("../utils/fileStorage");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;
const { autoActivatePartnerIfVerified } = require("../services/vendorActivation");
const { isKycDocumentsVerified, isDocumentTypeApplicable } = require("../utils/partnerVerification");
const fs = require("fs");

/* ============================================================
   ADMIN — KYC DOCUMENT REVIEW
============================================================ */

const listPendingDocuments = async (req, res) => {
  const documents = await PartnerDocument.find({ "verification.status": "pending" })
    .sort({ createdAt: 1 })
    .populate("partnerId", "partnerCode legalEntity.businessName");

  return res.json({ success: true, data: documents, incompletePartners: await require("../services/incompletePartnerChecks")("documents") });
};

const downloadDocument = async (req, res) => {
  const document = await PartnerDocument.findById(req.params.id);

  if (!document) {
    return res.status(404).json({ success: false, message: "Document not found." });
  }

  if (!(await sendStoredFile(res, document.file))) {
    return res.status(404).json({ success: false, message: "File not found on server." });
  }

  return undefined;
};

// Admin onboards a partner directly (no self-registration) and uploads
// their KYC documents on their behalf — e.g. from physical/scanned copies
// collected during onboarding. Still lands as "pending" and goes through
// the normal review queue rather than being auto-verified, since uploading
// isn't the same as reviewing.
const uploadDocumentForPartner = async (req, res) => {
  try {
    const { documentType } = req.body;
    const partnerId = req.params.id;

    if (!documentType) {
      return res.status(400).json({ success: false, message: "Document type is required." });
    }

    if (documentType === "partner_agreement") {
      return res.status(403).json({ success: false, message: "The partner agreement is generated automatically by SPOTX and can't be uploaded manually." });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "A file is required." });
    }

    const partner = await Partner.findById(partnerId);

    if (!partner) {
      return res.status(404).json({ success: false, message: "Partner not found." });
    }

    if (!isDocumentTypeApplicable(partner.partnerType, documentType)) {
      if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({
        success: false,
        message: `A ${documentType.replace(/_/g, " ")} is not needed for ${partner.partnerType} partners.`
      });
    }

    const document = await PartnerDocument.create({
      partnerId,
      documentType,
      file: await storeUploadedFile(req.file, String(partnerId)),
      verification: { status: "pending" }
    });

    // Same non-blocking status flip as the partner's own upload — a failure
    // here should never make an otherwise-successful upload look failed.
    try {
      if (partner.status === "draft") partner.status = "pending_verification";
      if (partner.verification.overallStatus === "not_submitted") partner.verification.overallStatus = "pending";
      await partner.save();
    } catch (statusError) {
      console.error("uploadDocumentForPartner: partner status flip failed (document was still saved):", statusError);
    }

    await logActivity({
      partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "document_uploaded",
      entityType: "PartnerDocument",
      entityId: document._id,
      description: `${req.adminUser.name} uploaded a ${documentType} document on behalf of the partner.`,
      req
    });

    await notifyAdmins({
      type: "document_uploaded",
      title: "KYC document to review",
      message: `${req.adminUser.name} uploaded a ${documentType.replace(/_/g, " ")} document for ${partnerLabel(partner)}.`,
      link: "/admin/documents",
      audienceRoles: ["kyc_reviewer"],
      partnerId: partner._id,
      entityType: "PartnerDocument",
      entityId: document._id,
      actorAdminId: req.adminUser._id
    });

    return res.status(201).json({ success: true, message: "Document uploaded.", data: document });
  } catch (error) {
    console.error("uploadDocumentForPartner error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode === 400 ? error.message : "Something went wrong uploading the document." });
  }
};

const verifyDocument = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;

    if (!["verified", "rejected"].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be 'verified' or 'rejected'." });
    }

    const document = await PartnerDocument.findById(req.params.id);

    if (!document) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }

    document.verification.status = status;
    document.verification.verifiedBy = req.adminUser._id;
    document.verification.verifiedAt = new Date();
    document.verification.rejectionReason = status === "rejected" ? rejectionReason || "" : "";

    await document.save();

    await logActivity({
      partnerId: document.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "document_verified",
      entityType: "PartnerDocument",
      entityId: document._id,
      description: `${req.adminUser.name} marked a ${document.documentType} document as ${status}.`,
      req
    });

    await PartnerNotification.create({
      partnerId: document.partnerId,
      type: "document_verified",
      title: `Document ${status}`,
      message: status === "rejected" && rejectionReason
        ? `Your ${document.documentType.replace(/_/g, " ")} document was rejected: ${rejectionReason}`
        : `Your ${document.documentType.replace(/_/g, " ")} document was ${status}.`,
      entity: { type: "PartnerDocument", entityId: document._id }
    });

    if (status === "verified") {
      const activation = await autoActivatePartnerIfVerified(document.partnerId, req.adminUser._id);

      // autoActivatePartnerIfVerified only activates once docs AND bank are
      // both verified — if it didn't activate but KYC alone just became
      // complete, the only thing left is the bank account, so nudge them
      // if they haven't even submitted one yet.
      if (!activation) {
        const partner = await Partner.findById(document.partnerId);
        const kycVerified = partner && (await isKycDocumentsVerified(document.partnerId, partner.partnerType));

        if (kycVerified) {
          const bankAccount = await PartnerBankAccount.findOne({ partnerId: document.partnerId });
          const bankVerified = bankAccount?.verification?.status === "verified";

          // Covers both cases: no bank account submitted yet, AND one
          // submitted but still sitting unverified — either way, it's the
          // one thing left before the account can be used.
          if (!bankVerified) {
            const alreadyNotified = await PartnerNotification.exists({
              partnerId: document.partnerId,
              type: "kyc_verified_awaiting_bank"
            });

            if (!alreadyNotified) {
              await PartnerNotification.create({
                partnerId: document.partnerId,
                type: "kyc_verified_awaiting_bank",
                title: "KYC verified — bank account still needed",
                message: bankAccount
                  ? "Your KYC documents are all verified. Your bank account is still pending verification — once that's approved, you'll be able to use your account."
                  : "Your KYC documents are all verified. Submit your bank account details and get them verified to start using your account.",
                entity: { type: "Partner", entityId: document.partnerId }
              });
            }
          }
        }
      }
    }

    return res.json({ success: true, message: "Document reviewed.", data: document });
  } catch (error) {
    console.error("verifyDocument error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong reviewing the document." });
  }
};

module.exports = { listPendingDocuments, downloadDocument, verifyDocument, uploadDocumentForPartner };
