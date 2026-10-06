const express = require("express");
const router = express.Router();

const { listDocuments, uploadDocument, downloadDocument } = require("../controller/partnerDocumentController");
const requirePermission = require("../middleware/requirePermission");
const { uploadDocument: uploadMiddleware } = require("../middleware/upload");
const { requireFileStorage } = require("../utils/fileStorage");

router.get("/", requirePermission("documents:view"), listDocuments);
router.post("/", requirePermission("documents:upload"), requireFileStorage, uploadMiddleware.single("file"), uploadDocument);
router.get("/:id/download", requirePermission("documents:view"), downloadDocument);

module.exports = router;
