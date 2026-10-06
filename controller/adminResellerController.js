const runWithLease = require("../utils/runWithLease");
const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Partner = require("../models/Partner");
const ResellerInventory = require("../models/ResellerInventory");
const ResellerCustomer = require("../models/ResellerCustomer");
const CustomerAllocation = require("../models/CustomerAllocation");
const ResellerInvoice = require("../models/ResellerInvoice");
const { runBillingForAllPartners, markOverdueInvoices, ensureOrderBilling, generateInvoicesForOrder } = require("../services/resellerBilling");
const { computeOrderPricing } = require("../services/resellerPricing");
const ScreenLicensePurchaseOrder = require("../models/ScreenLicensePurchaseOrder");
const { runResellerNotificationChecks } = require("../services/resellerNotifications");
const { applyPaidInvoice } = require("../services/resellerInvoicePaymentFulfillment");
const resellerInventory = require("../services/resellerInventory");
const { fetchPaymentById } = require("../utils/razorpay");
const { claimPayment } = require("../utils/assertPaymentNotReused");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");

/* ============================================================
   ADMIN — RESELLER (CROSS-PARTNER DASHBOARD + DETAIL + BILLING RUN)
============================================================ */

// Cross-partner view of every reseller's own end customers — admin has no
// role in managing them (that's the reseller's job), this is read-only
// oversight only. Optional `search` (company/contact/email) and `status`
// filters; `partnerId` narrows to one reseller (used from the partner
// detail page, if ever needed there).
const listAllCustomers = asyncHandler(async (req, res) => {
  const { search, status, partnerId } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (partnerId) filter.partnerId = partnerId;
  if (search) {
    const re = new RegExp(search.trim(), "i");
    filter.$or = [
      { "businessDetails.companyName": re },
      { "contactDetails.name": re },
      { "contactDetails.email": re }
    ];
  }

  const customers = await ResellerCustomer.find(filter)
    .populate("partnerId", "legalEntity.businessName partnerCode")
    .sort({ createdAt: -1 })
    .lean();

  const customerIds = customers.map((c) => c._id);
  const allocations = await CustomerAllocation.find({ customerId: { $in: customerIds }, status: { $ne: "cancelled" } }).lean();

  const allocationByCustomer = new Map(allocations.map((a) => [String(a.customerId), a]));

  const data = customers.map((c) => {
    const allocation = allocationByCustomer.get(String(c._id));
    return {
      ...c,
      allocation: allocation
        ? {
            allocatedLicenses: allocation.allocatedLicenses,
            registeredScreens: allocation.registeredScreens,
            activeScreens: allocation.activeScreens,
            suspendedScreens: allocation.suspendedScreens
          }
        : null
    };
  });

  return res.json({ success: true, data });
});

const listInvoices = asyncHandler(async (req, res) => {
  const { partnerId, status } = req.query;
  const validStatuses = ["pending", "paid", "failed", "overdue"];

  if (partnerId && !mongoose.isValidObjectId(partnerId)) {
    return res.status(400).json({ success: false, message: "Invalid partner ID." });
  }
  if (status && !validStatuses.includes(status)) {
    return res.status(400).json({ success: false, message: "Invalid reseller invoice status." });
  }

  const filter = {};
  if (status) filter.paymentStatus = status;
  if (partnerId) {
    const reseller = await Partner.exists({ _id: partnerId, partnerType: "reseller" });
    if (!reseller) return res.json({ success: true, data: [] });
    filter.partnerId = partnerId;
  }

  const invoices = await ResellerInvoice.find(filter)
    .sort({ createdAt: -1 })
    .populate("partnerId", "partnerCode partnerType primaryContact.name legalEntity.businessName")
    .populate("paymentHistory.recordedBy", "name")
    .lean();

  return res.json({ success: true, data: invoices });
});

const getDashboard = asyncHandler(async (req, res) => {
  const partners = await Partner.find({ partnerType: "reseller" }).select("_id status");
  const partnerIds = partners.map((p) => p._id);

  const inventories = await ResellerInventory.find({ partnerId: { $in: partnerIds } });

  const totals = inventories.reduce(
    (acc, inv) => {
      acc.totalPurchased += inv.totalPurchasedLicenses;
      acc.totalAllocated += inv.totalAllocatedLicenses;
      acc.totalActive += inv.totalActiveScreens;
      acc.totalAvailable += Math.max(0, inv.totalPurchasedLicenses - inv.totalAllocatedLicenses);
      return acc;
    },
    { totalPurchased: 0, totalAllocated: 0, totalActive: 0, totalAvailable: 0 }
  );

  const [pendingInvoices, overdueInvoices, failedInvoices] = await Promise.all([
      ResellerInvoice.countDocuments({ partnerId: { $in: partnerIds }, paymentStatus: "pending" }),
      ResellerInvoice.countDocuments({ partnerId: { $in: partnerIds }, paymentStatus: "overdue" }),
      ResellerInvoice.countDocuments({ partnerId: { $in: partnerIds }, paymentStatus: "failed" })
    ]);

  return res.json({
      success: true,
      data: {
        totalPartners: partners.length,
        suspendedPartners: partners.filter((p) => p.status === "suspended").length,
        ...totals,
        pendingInvoices,
        overdueInvoices,
        failedInvoices
      }
    });
});

const getPartnerDetail = asyncHandler(async (req, res) => {
  const partner = await Partner.findById(req.params.id);
  if (!partner || partner.partnerType !== "reseller") {
    return res.status(404).json({ success: false, message: "Reseller partner not found." });
  }

  const [inventory, customerCounts, invoices] = await Promise.all([
      resellerInventory.getOrCreateInventory(partner._id),
      ResellerCustomer.aggregate([
        { $match: { partnerId: partner._id } },
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ]),
      ResellerInvoice.find({ partnerId: partner._id }).sort({ createdAt: -1 }).limit(50)
    ]);

  return res.json({
      success: true,
      data: {
        partner,
        inventory,
        customerCounts: customerCounts.reduce((acc, c) => ({ ...acc, [c._id]: c.count }), {}),
        invoices
      }
    });
});

// Manual for this release.
// Idempotent per partner/period via ResellerInvoice's unique index, so
// wiring this to a scheduler later is a matter of calling the same
// service from a cron trigger.
const runBillingNow = asyncHandler(async (req, res) => {
  const data = await runWithLease("reseller-billing", async () => {
    const results = await runBillingForAllPartners({ performedByUserId: req.adminUser._id });
    const overdueMarked = await markOverdueInvoices();
    const notifications = await runResellerNotificationChecks();
    return { results, overdueMarked, notifications };
  });
  return res.json({ success: true, message: data.skipped ? "Another billing run is already in progress." : "Reseller billing run complete.", data });
});

// Standalone trigger for overdue-marking + the three notification checks
// (due-date reminders, low-inventory alerts, agreement-expiring flags) —
// useful on days no billing run happens. No scheduler exists yet (see
// B12 item 1), so this is an admin-clicked action for now.
const checkNotifications = asyncHandler(async (req, res) => {
  const data = await runWithLease("reseller-billing", async () => {
    const overdueMarked = await markOverdueInvoices();
    const notifications = await runResellerNotificationChecks();
    return { overdueMarked, ...notifications };
  });
  return res.json({ success: true, message: data.skipped ? "Another billing run is already in progress." : "Notification checks complete.", data });
});

// Superadmin-only manual inventory correction, always logged with a
// reason and applied through the same invariant-guarded service as
// every other inventory mutation — never a direct write.
const adjustInventory = asyncHandler(async (req, res) => {
  try {
    const partner = await Partner.findById(req.params.id);
    if (!partner || partner.partnerType !== "reseller") {
      return res.status(404).json({ success: false, message: "Reseller partner not found." });
    }

    const { quantity, reason } = req.body;
    if (!quantity || !reason) {
      return res.status(400).json({ success: false, message: "quantity and reason are both required." });
    }

    const inventory = await resellerInventory.adjust({
      partnerId: partner._id,
      quantity: parseInt(quantity, 10),
      reason,
      createdBy: req.adminUser._id
    });

    // Licences an admin adds are billed the same way as ones the reseller
    // buys: as their own bill, at today's plan price, from today. Taking
    // licences away doesn't change any bill.
    const added = parseInt(quantity, 10);
    if (added > 0) {
      const { plan, pricing } = await computeOrderPricing({ partnerId: partner._id, quantity: added });
      const adjustmentOrder = await ScreenLicensePurchaseOrder.create({
        partnerId: partner._id,
        quantity: added,
        pricing,
        pricingPlanId: plan._id,
        status: "paid",
        orderStatus: "completed",
        paymentMode: "offline",
        licensesApplied: true,
        orderCode: `ADJ-${Date.now().toString(36).toUpperCase()}`,
        approval: { approvedBy: req.adminUser._id, approvedAt: new Date() }
      });
      await ensureOrderBilling(adjustmentOrder, { startDate: new Date(), legacy: false });
      await generateInvoicesForOrder(adjustmentOrder, { performedByUserId: req.adminUser._id });
    }

    await logActivity({
      partnerId: partner._id,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "license_adjusted",
      entityType: "ResellerInventory",
      entityId: inventory._id,
      description: `Manual inventory adjustment: ${quantity > 0 ? "+" : ""}${quantity} licenses — ${reason}`,
      req
    });

    await notifyPartner({
      partnerId: partner._id,
      type: "license_inventory_adjusted",
      title: "SPOTX adjusted your license inventory",
      message: `${quantity > 0 ? "+" : ""}${parseInt(quantity, 10)} licenses — ${reason}`,
      entityType: "ResellerInventory",
      entityId: inventory._id
    });

    return res.json({ success: true, message: "Inventory adjusted.", data: inventory });
  } catch (error) {
    console.error("adjustInventory error:", error);
    return res.status(400).json({ success: false, message: error.message || "Something went wrong adjusting inventory." });
  }
});

// Every invoice defaults to "offline" (see ResellerInvoice.paymentMode) —
// SPOTX collects it manually. Switching an invoice to "online" is what
// unlocks the reseller's own "Pay Now" button on their Billing page
// (still gated by the payment window — see
// partnerResellerBillingController.attachPayWindow). Mirrors
// adminResellerConfigController.setPrepayment's online branch.
const setInvoicePaymentMode = asyncHandler(async (req, res) => {
  const invoice = await ResellerInvoice.findById(req.params.id);
  if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found." });

  if (invoice.paymentStatus === "paid") {
    return res.status(400).json({ success: false, message: "This invoice is already paid." });
  }
  if (invoice.paymentMode === "online") {
    return res.status(400).json({ success: false, message: "This invoice is already set for online payment." });
  }

  invoice.paymentMode = "online";
  invoice.onlineRequested = false;
  await invoice.save();

  await logActivity({
      partnerId: invoice.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "ResellerInvoice",
      entityId: invoice._id,
      description: `${req.adminUser.name} switched invoice ${invoice.invoiceNumber} to online payment — the reseller can now pay it from their panel.`,
      req
    });

  await notifyPartner({
    partnerId: invoice.partnerId,
    type: "reseller_invoice_online_enabled",
    title: "You can now pay an invoice online",
    message: `Invoice ${invoice.invoiceNumber} can be paid online from Billing & Payments.`,
    entityType: "ResellerInvoice",
    entityId: invoice._id
  });

  return res.json({ success: true, message: "Invoice switched to online payment.", data: invoice });
});

// Admin already has a transaction reference for a payment made outside
// the app — checked against Razorpay directly and applied immediately if
// it's captured and the amount matches. Same online/offline verification
// pattern as adminResellerConfigController.setPrepayment's offline branch
// and the (now-removed) per-order offline flow — reused here at the
// invoice level via the shared assertPaymentNotReused guard against one
// real payment being credited to two different invoices by mistake.
const verifyInvoiceOfflinePayment = asyncHandler(async (req, res) => {
  try {
    const invoice = await ResellerInvoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found." });

    if (invoice.paymentStatus === "paid") {
      return res.status(400).json({ success: false, message: "This invoice is already paid." });
    }

    const { transactionId, method = "razorpay" } = req.body;
    if (!["razorpay", "cheque", "cash"].includes(method)) {
      return res.status(400).json({ success: false, message: "Invalid offline payment method." });
    }
    if (typeof transactionId !== "string" || !transactionId.trim()) {
      return res.status(400).json({ success: false, message: "Enter a payment ID, cheque number or cash receipt number." });
    }

    const chequeStatus = req.body.chequeStatus || "cleared";
    if (method === "cheque" && !["received", "cleared", "bounced"].includes(chequeStatus)) {
      return res.status(400).json({ success: false, message: "Invalid cheque status." });
    }
    if (method === "cheque" && chequeStatus !== "cleared") {
      const updated = await ResellerInvoice.findOneAndUpdate(
        { _id: invoice._id, paymentStatus: { $ne: "paid" } },
        {
          $set: { cheque: { number: transactionId.trim(), status: chequeStatus, updatedAt: new Date(), updatedBy: req.adminUser._id } },
          $push: { paymentHistory: { action: `cheque_${chequeStatus}`, method, reference: transactionId.trim(), amount: invoice.total, recordedAt: new Date(), recordedBy: req.adminUser._id } }
        },
        { returnDocument: "after", runValidators: true }
      );
      if (!updated) return res.status(409).json({ success: false, message: "Invoice was already paid." });
      return res.json({ success: true, message: `Cheque ${chequeStatus} recorded. Invoice remains unpaid.`, data: updated });
    }

    let payment;
    if (method === "razorpay") {
      payment = await fetchPaymentById(transactionId.trim());

      if (payment.status !== "captured") {
        return res.status(400).json({
          success: false,
          message: `This payment shows as "${payment.status}" on Razorpay, not captured — it can't be verified yet.`
        });
      }

      if (payment.amount !== Math.round(invoice.total * 100)) {
        return res.status(400).json({
          success: false,
          message: `This payment's amount (₹${(payment.amount / 100).toLocaleString("en-IN")}) doesn't match the invoice total (₹${invoice.total.toLocaleString("en-IN")}).`
        });
      }

      await claimPayment(payment.id, `invoice:${invoice._id}`);
    }

    const applied = await applyPaidInvoice(invoice._id, {
      razorpayPaymentId: payment?.id,
      offlinePayment: {
        method,
        transactionId: transactionId.trim(),
        verifiedBy: req.adminUser._id,
        verifiedAt: new Date()
      }
    });
    if (!applied) {
      return res.status(409).json({ success: false, message: "This invoice was already processed." });
    }

    await logActivity({
      partnerId: invoice.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "ResellerInvoice",
      entityId: invoice._id,
      description: `${req.adminUser.name} verified an ${method} payment (ref: ${transactionId.trim()}) for invoice ${invoice.invoiceNumber}.`,
      req
    });

    return res.json({ success: true, message: "Payment verified — invoice marked paid.", data: applied });
  } catch (error) {
    console.error("verifyInvoiceOfflinePayment error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode ? error.message : "Something went wrong verifying this payment." });
  }
});

module.exports = {
  listAllCustomers, listInvoices, getDashboard, getPartnerDetail, runBillingNow, checkNotifications, adjustInventory,
  setInvoicePaymentMode, verifyInvoiceOfflinePayment
};
