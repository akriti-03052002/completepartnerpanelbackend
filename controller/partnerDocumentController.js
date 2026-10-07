const { PartnerDocument } = require("../models/Index");
const logActivity = require("../utils/logActivity");
const { storeUploadedFile, sendStoredFile } = require("../utils/fileStorage");
const { isDocumentTypeApplicable } = require("../utils/partnerVerification");
const fs = require("fs");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;

/* ============================================================
   PARTNER KYC DOCUMENTS
============================================================ */

const listDocuments = async (req, res) => {
  const documents = await PartnerDocument.find({ partnerId: req.partner._id }).sort({ createdAt: -1 });

  return res.json({ success: true, data: documents });
};

const uploadDocument = async (req, res) => {
  try {
    const { documentType, documentNumber } = req.body;

    if (!documentType) {
      return res.status(400).json({ success: false, message: "Document type is required." });
    }

    // System-generated on verification (see services/generatePartnerAgreement.js)
    // — a partner never uploads their own.
    // An influencer is an individual, not a business — GST / MSME documents
    // don't apply to them (see utils/partnerVerification.js).
    if (!isDocumentTypeApplicable(req.partner.partnerType, documentType)) {
      if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({
        success: false,
        message: `A ${documentType.replace(/_/g, " ")} is not needed for ${req.partner.partnerType} partners.`
      });
    }

    if (documentType === "partner_agreement") {
      return res.status(403).json({ success: false, message: "The partner agreement is generated automatically by SPOTX and can't be uploaded manually." });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "A file is required." });
    }

    const document = await PartnerDocument.create({
      partnerId: req.partner._id,
      documentType,
      documentNumber: documentNumber || "",
      file: await storeUploadedFile(req.file, String(req.partner._id)),
      verification: { status: "pending" }
    });

    // First submission of anything moves the partner out of "draft"/"not
    // submitted" limbo so the admin queue (and the partner's own status
    // badges) actually reflect that review is needed — nothing else in
    // this flow ever flips these on the way in, only on verification.
    // Kept in its own try/catch: the document is already safely saved above,
    // so a failure here should never make the upload look like it failed.
    try {
      if (req.partner.status === "draft") req.partner.status = "pending_verification";
      if (req.partner.verification.overallStatus === "not_submitted") req.partner.verification.overallStatus = "pending";
      await req.partner.save();
    } catch (statusError) {
      console.error("uploadDocument: partner status flip failed (document was still saved):", statusError);
    }

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "document_uploaded",
      entityType: "PartnerDocument",
      entityId: document._id,
      description: `${req.partnerUser.name} uploaded a ${documentType} document.`,
      req
    });

    await notifyAdmins({
      type: "document_uploaded",
      title: "KYC document to review",
      message: `${partnerLabel(req.partner)} uploaded a ${documentType.replace(/_/g, " ")} document.`,
      link: "/admin/documents",
      audienceRoles: ["kyc_reviewer"],
      partnerId: req.partner._id,
      entityType: "PartnerDocument",
      entityId: document._id
    });

    return res.status(201).json({ success: true, message: "Document uploaded.", data: document });
  } catch (error) {
    console.error("uploadDocument error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode === 400 ? error.message : "Something went wrong uploading the document." });
  }
};

const downloadDocument = async (req, res) => {
  try {
    const document = await PartnerDocument.findOne({ _id: req.params.id, partnerId: req.partner._id });

    if (!document) {
      return res.status(404).json({ success: false, message: "Document not found." });
    }

    if (!(await sendStoredFile(res, document.file))) {
      return res.status(404).json({ success: false, message: "File not found on server." });
    }

    return undefined;
  } catch (error) {
    console.error("downloadDocument error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong downloading the document." });
  }
};

module.exports = { listDocuments, uploadDocument, downloadDocument };
