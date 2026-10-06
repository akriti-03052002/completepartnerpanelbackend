const express = require("express");
const router = express.Router();

const {
  createPartner, listPartners, getPartner, updatePartnerStatus, assignTier,
  assignCustomCommission, getCommissionAssignment,
  updatePartnerProfile, updateTeamMember,
  getAgreementTerms, updateAgreementTerms, regenerateAgreement
} = require("../controller/adminPartnerController");
const { uploadDocumentForPartner } = require("../controller/adminDocumentController");
const requireAdminRole = require("../middleware/requireAdminRole");
const { uploadDocumentAsAdmin } = require("../middleware/upload");
const { requireFileStorage } = require("../utils/fileStorage");

router.post("/", requireAdminRole("kyc_reviewer"), createPartner);
router.get("/", requireAdminRole("kyc_reviewer", "finance"), listPartners);
router.post("/:id/resend-invitation", requireAdminRole("kyc_reviewer"), require("../controller/adminPartnerController").resendInvitation);
router.get("/:id", requireAdminRole("kyc_reviewer", "finance"), getPartner);
router.patch("/:id", requireAdminRole("kyc_reviewer"), updatePartnerProfile);
router.patch("/:id/status", requireAdminRole("kyc_reviewer"), updatePartnerStatus);
router.patch("/:id/team/:userId", requireAdminRole("kyc_reviewer"), updateTeamMember);
router.get("/:id/agreement-terms", requireAdminRole("kyc_reviewer"), getAgreementTerms);
router.patch("/:id/agreement-terms", requireAdminRole("kyc_reviewer"), updateAgreementTerms);
router.post("/:id/agreement/regenerate", requireAdminRole("kyc_reviewer"), regenerateAgreement);
router.patch("/:id/tier", requireAdminRole("kyc_reviewer"), assignTier);
router.get("/:id/commission-assignment", requireAdminRole("kyc_reviewer", "finance"), getCommissionAssignment);
router.post("/:id/commission-assignment", requireAdminRole("kyc_reviewer"), assignCustomCommission);
router.post("/:id/documents", requireAdminRole("kyc_reviewer"), requireFileStorage, uploadDocumentAsAdmin.single("file"), uploadDocumentForPartner);

module.exports = router;
