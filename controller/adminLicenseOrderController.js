const asyncHandler = require("express-async-handler");
const ScreenLicensePurchaseOrder = require("../models/ScreenLicensePurchaseOrder");
const { PartnerNotification } = require("../models/Index");
const { applyPaidLicenseOrder } = require("../services/resellerLicenseOrderFulfillment");
const logActivity = require("../utils/logActivity");

/* ============================================================
   ADMIN — SCREEN LICENSE PURCHASE ORDER REVIEW
   Every purchase starts as a partner's request (orderStatus
   "requested"). createLicenseOrder already refuses to let a
   partner request anything until their one-time prepayment is
   done (see requirePrepaymentDone) — so by the time an order gets
   here, this reseller has already cleared that gate. Accepting
   credits the licenses immediately and turns the purchase into its
   own bill: its billing cycle starts that day and the first cycle
   is invoiced straight away (see services/resellerBilling.js).
============================================================ */

const listLicenseOrders = async (req, res) => {
  const filter = {};
  if (req.query.status) filter.orderStatus = { $in: req.query.status.split(",") };

  const orders = await ScreenLicensePurchaseOrder.find(filter)
    .sort({ createdAt: -1 })
    .populate("partnerId", "partnerCode legalEntity.businessName");

  return res.json({ success: true, data: orders });
};

const acceptLicenseOrder = asyncHandler(async (req, res) => {
  const order = await ScreenLicensePurchaseOrder.findById(req.params.id);

  if (!order) {
    return res.status(404).json({ success: false, message: "Purchase order not found." });
  }

  if (order.orderStatus !== "requested") {
    return res.status(400).json({ success: false, message: "This request has already been reviewed." });
  }

  order.approval.approvedBy = req.adminUser._id;
  order.approval.approvedAt = new Date();
  await order.save();

  const applied = await applyPaidLicenseOrder(order._id, { razorpayPaymentId: "", method: "billing_cycle" });

  if (!applied) {
    return res.status(409).json({ success: false, message: "This order was already processed." });
  }

  await PartnerNotification.create({
    partnerId: order.partnerId,
    type: "license_order_approved",
    title: "Your license request was approved",
    message: `${order.quantity} licenses (order ${order.orderCode}) have been added to your inventory. This purchase has its own bill starting today — the first invoice is in Billing & Payments.`,
    entity: { type: "ScreenLicensePurchaseOrder", entityId: order._id }
  });

  await logActivity({
    partnerId: order.partnerId,
    performedByType: "spotx_user",
    performedByUserId: req.adminUser._id,
    activityType: "note",
    entityType: "ScreenLicensePurchaseOrder",
    entityId: order._id,
    description: `${req.adminUser.name} accepted license request ${order.orderCode} — ${order.quantity} licenses added, billed as its own purchase from today.`,
    req
  });

  return res.json({ success: true, message: "Request accepted — licenses added.", data: applied });
});

const rejectLicenseOrder = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  if (!reason?.trim()) {
    return res.status(400).json({ success: false, message: "A reason is required to reject a request." });
  }

  const order = await ScreenLicensePurchaseOrder.findById(req.params.id);

  if (!order) {
    return res.status(404).json({ success: false, message: "Purchase order not found." });
  }

  if (order.orderStatus !== "requested") {
    return res.status(400).json({ success: false, message: "This request has already been reviewed." });
  }

  order.orderStatus = "rejected";
  order.approval.rejectedBy = req.adminUser._id;
  order.approval.rejectedAt = new Date();
  order.approval.rejectionReason = reason.trim();
  await order.save();

  await PartnerNotification.create({
    partnerId: order.partnerId,
    type: "license_order_rejected",
    title: "Your license request was declined",
    message: `Your request for ${order.quantity} licenses (order ${order.orderCode}) was declined: ${reason.trim()}`,
    entity: { type: "ScreenLicensePurchaseOrder", entityId: order._id }
  });

  await logActivity({
    partnerId: order.partnerId,
    performedByType: "spotx_user",
    performedByUserId: req.adminUser._id,
    activityType: "note",
    entityType: "ScreenLicensePurchaseOrder",
    entityId: order._id,
    description: `${req.adminUser.name} rejected license request ${order.orderCode}: ${reason.trim()}`,
    req
  });

  return res.json({ success: true, message: "Request rejected.", data: order });
});

module.exports = { listLicenseOrders, acceptLicenseOrder, rejectLicenseOrder };
