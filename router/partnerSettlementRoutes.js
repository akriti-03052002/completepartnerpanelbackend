const express = require("express");
const router = express.Router();

const { listSettlements, getSettlementDetail, getSettlementHistoryForPartner } = require("../controller/partnerSettlementController");
const { submitBill, getBillForSettlement } = require("../controller/partnerSettlementBillController");
const requirePermission = require("../middleware/requirePermission");
const { uploadBill } = require("../middleware/upload");
const { requireFileStorage } = require("../utils/fileStorage");

router.get("/", requirePermission("settlements:view"), listSettlements);
router.get("/:id", requirePermission("settlements:view"), getSettlementDetail);
router.get("/:id/bill", requirePermission("settlements:view"), getBillForSettlement);
router.get("/:id/history", requirePermission("settlements:view"), getSettlementHistoryForPartner);
router.post("/:id/bill", requirePermission("settlements:view"), requireFileStorage, uploadBill.single("file"), submitBill);

module.exports = router;
