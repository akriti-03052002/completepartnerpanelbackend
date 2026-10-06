const express = require("express");
const router = express.Router();

const { listPendingDocuments, downloadDocument, verifyDocument } = require("../controller/adminDocumentController");
const requireAdminRole = require("../middleware/requireAdminRole");

router.get("/pending", requireAdminRole("kyc_reviewer"), listPendingDocuments);
router.get("/:id/download", requireAdminRole("kyc_reviewer"), downloadDocument);
router.patch("/:id/verify", requireAdminRole("kyc_reviewer"), verifyDocument);

module.exports = router;
