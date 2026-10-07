const express = require("express");
const router = express.Router();

const requireResellerPartner = require("../middleware/requireResellerPartner");
const blockIfResellerPaymentRestricted = require("../middleware/blockIfResellerPaymentRestricted");
const requirePermission = require("../middleware/requirePermission");

const { getInventory, listTransactions } = require("../controller/partnerResellerInventoryController");
const { createLicenseOrder, listLicenseOrders, getLicenseOrder } = require("../controller/partnerLicenseOrderController");
const { listCustomers, getResellerReferral, getCustomer, createCustomer, updateCustomer } = require("../controller/partnerResellerCustomerController");
const {
  listAllocations, allocateLicenses, releaseLicenses, suspendCustomer, reactivateCustomer, cancelAllocation
} = require("../controller/partnerAllocationController");
const {
  listInvoices, getInvoice, getCurrentDueEstimate, requestOnlinePayment, createInvoicePaymentOrder, verifyInvoicePayment,
  getPrepaymentStatus, createPrepaymentOrder, verifyPrepaymentPayment
} = require("../controller/partnerResellerBillingController");

// Mounted at /api/partner/reseller under the same verifiedGuard as every
// other partner-facing route group (see index.js), plus this Reseller-
// only gate — no impact on any other partnerType's routes/files.
router.use(requireResellerPartner);

// Inventory
router.get("/inventory", requirePermission("reseller:inventory:view"), getInventory);
router.get("/inventory/transactions", requirePermission("reseller:inventory:view"), listTransactions);

// License purchase orders — request-then-accept (see
// ScreenLicensePurchaseOrder's orderStatus comment): a request here only
// creates the request. Requesting requires the one-time prepayment to
// already be done; once an admin accepts a request the licenses are
// credited immediately and billed via the partner's regular cycle — no
// separate per-order payment step for the partner to complete here.
router.post("/license-orders", requirePermission("reseller:license:purchase"), blockIfResellerPaymentRestricted, createLicenseOrder);
router.get("/license-orders", requirePermission("reseller:license:purchase"), listLicenseOrders);
router.get("/license-orders/:id", requirePermission("reseller:license:purchase"), getLicenseOrder);

// Customers
router.get("/referral", requirePermission("reseller:customers:manage"), getResellerReferral);
router.get("/customers", requirePermission("reseller:customers:manage"), listCustomers);
router.get("/customers/:id", requirePermission("reseller:customers:manage"), getCustomer);
router.post("/customers", requirePermission("reseller:customers:manage"), createCustomer);
router.patch("/customers/:id", requirePermission("reseller:customers:manage"), updateCustomer);

// Allocation lifecycle — release/suspend/reactivate/cancel stay open even
// when restricted (a partner can still manage down their own commitments
// and pay their way out — see blockIfResellerPaymentRestricted). Only
// actions that grow what the partner owes/promises are blocked.
// allocateLicenses registers + activates in the same call now — there's
// no separate manual register/activate step (see partnerAllocationController.js).
router.get("/allocations", requirePermission("reseller:allocation:manage"), listAllocations);
router.post("/allocations", requirePermission("reseller:allocation:manage"), blockIfResellerPaymentRestricted, allocateLicenses);
router.post("/allocations/:id/release", requirePermission("reseller:allocation:manage"), releaseLicenses);
router.post("/allocations/:id/suspend", requirePermission("reseller:allocation:manage"), suspendCustomer);
router.post("/allocations/:id/reactivate", requirePermission("reseller:allocation:manage"), reactivateCustomer);
router.post("/allocations/:id/cancel", requirePermission("reseller:allocation:manage"), cancelAllocation);

// Billing
router.get("/invoices", requirePermission("reseller:billing:view"), listInvoices);
router.get("/invoices/current-due", requirePermission("reseller:billing:view"), getCurrentDueEstimate);
router.get("/invoices/:id", requirePermission("reseller:billing:view"), getInvoice);
router.post("/invoices/:id/request-online", requirePermission("reseller:billing:pay"), requestOnlinePayment);
router.post("/invoices/:id/pay", requirePermission("reseller:billing:pay"), createInvoicePaymentOrder);
router.post("/invoices/:id/verify", requirePermission("reseller:billing:pay"), verifyInvoicePayment);

// One-time prepayment — required before any license purchase request
// (see createLicenseOrder's gate in partnerLicenseOrderController.js).
router.get("/prepayment", requirePermission("reseller:billing:view"), getPrepaymentStatus);
router.post("/prepayment/pay", requirePermission("reseller:billing:pay"), createPrepaymentOrder);
router.post("/prepayment/verify", requirePermission("reseller:billing:pay"), verifyPrepaymentPayment);

router.get("/invoices/:id/download", requirePermission("reseller:billing:view"), require("../controller/invoiceDownloadController").downloadInvoice("reseller", "partner"));

module.exports = router;
