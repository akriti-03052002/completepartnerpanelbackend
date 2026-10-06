const express = require("express");
const router = express.Router();

const {
  listSettlements, createSettlement, approveSettlement, markSettlementPaid, markSettlementPaidOffline,
  getSettlementDetail, holdSettlement, releaseSettlement, failSettlement, retrySettlement,
  fetchRazorpayPayment, getPayoutDetails, checkOnlinePayout, getBillForSettlementAsAdmin, downloadBillAsAdmin, verifyBill,
  getSettlementHistoryAsAdmin
} = require("../controller/adminSettlementController");
const requireAdminRole = require("../middleware/requireAdminRole");

router.get("/", requireAdminRole("finance"), listSettlements);
router.get("/razorpay-payment/:paymentId", requireAdminRole("finance"), fetchRazorpayPayment);
router.post("/", requireAdminRole("finance"), createSettlement);
router.get("/:id", requireAdminRole("finance"), getSettlementDetail);
router.get("/:id/payout-details", requireAdminRole("finance"), getPayoutDetails);
router.get("/:id/online-check", requireAdminRole("finance"), checkOnlinePayout);
router.patch("/:id/approve", requireAdminRole("finance"), approveSettlement);
router.patch("/:id/mark-paid", requireAdminRole("finance"), markSettlementPaid);
router.patch("/:id/mark-paid-offline", requireAdminRole("finance"), markSettlementPaidOffline);
router.patch("/:id/hold", requireAdminRole("finance"), holdSettlement);
router.patch("/:id/release", requireAdminRole("finance"), releaseSettlement);
router.patch("/:id/fail", requireAdminRole("finance"), failSettlement);
router.patch("/:id/retry", requireAdminRole("finance"), retrySettlement);
router.get("/:id/bill", requireAdminRole("finance"), getBillForSettlementAsAdmin);
router.get("/:id/bill/download", requireAdminRole("finance"), downloadBillAsAdmin);
router.patch("/:id/bill/verify", requireAdminRole("finance"), verifyBill);
router.get("/:id/history", requireAdminRole("finance"), getSettlementHistoryAsAdmin);

module.exports = router;
