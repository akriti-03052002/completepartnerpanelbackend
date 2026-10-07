const express = require("express");
const router = express.Router();
const requireAdminRole = require("../middleware/requireAdminRole");
router.use((req, res, next) => {
  const readOnly = req.method === "GET";
  return requireAdminRole(...(readOnly ? ["finance", "kyc_reviewer"] : ["finance"]))(req, res, next);
});

const { getPricingPlan, updatePricingPlan, getBillingConfig, updateBillingConfig, setPrepayment } = require("../controller/adminResellerConfigController");
const {
  listAllCustomers, listInvoices, getDashboard, getPartnerDetail, runBillingNow, checkNotifications, adjustInventory,
  setInvoicePaymentMode, verifyInvoiceOfflinePayment
} = require("../controller/adminResellerController");
const {
  listLicenseOrders, acceptLicenseOrder, rejectLicenseOrder
} = require("../controller/adminLicenseOrderController");

// Mounted at /api/admin/reseller behind adminAuthMiddleware (see index.js)
// — same separate admin auth as every other admin route, no change to
// any other admin route group.
router.get("/customers", listAllCustomers);
router.get("/invoices", listInvoices);
router.get("/dashboard", getDashboard);
router.post("/run-billing", runBillingNow);
router.post("/check-notifications", checkNotifications);

router.get("/partners/:id", getPartnerDetail);
router.get("/partners/:id/pricing-plan", getPricingPlan);
router.put("/partners/:id/pricing-plan", updatePricingPlan);
router.get("/partners/:id/billing-config", getBillingConfig);
router.put("/partners/:id/billing-config", updateBillingConfig);
router.patch("/partners/:id/prepayment", setPrepayment);
router.post("/partners/:id/adjust-inventory", adjustInventory);

// License purchase order review — request-then-accept-or-reject (see
// ScreenLicensePurchaseOrder's orderStatus comment): no per-order payment
// step anymore, accepting credits licenses immediately.
router.get("/license-orders", listLicenseOrders);
router.patch("/license-orders/:id/accept", acceptLicenseOrder);
router.patch("/license-orders/:id/reject", rejectLicenseOrder);

// Invoice payment mode — every invoice defaults to "offline" (SPOTX
// collects manually); an admin can switch a specific invoice to "online"
// (unlocks the reseller's own Pay Now) or verify an offline reference
// directly (marks it paid immediately).
router.patch("/invoices/:id/payment-mode", setInvoicePaymentMode);
router.patch("/invoices/:id/verify-offline", verifyInvoiceOfflinePayment);

router.get("/invoices/:id/download", require("../controller/invoiceDownloadController").downloadInvoice("reseller", "admin"));

module.exports = router;
