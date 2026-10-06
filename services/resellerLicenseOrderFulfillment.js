const { claimPayment } = require("../utils/assertPaymentNotReused");
const ScreenLicensePurchaseOrder = require("../models/ScreenLicensePurchaseOrder");
const resellerInventory = require("./resellerInventory");
const logActivity = require("../utils/logActivity");
const { ensureOrderBilling, generateInvoicesForOrder } = require("./resellerBilling");

/* ============================================================
   RESELLER LICENSE ORDER FULFILLMENT
   Called when an admin accepts a license request (see
   adminLicenseOrderController.acceptLicenseOrder) — a request only
   ever reaches acceptance once the reseller's one-time prepayment
   is already done, so there's no per-order payment to verify here;
   this just credits the licenses. razorpayPaymentId is passed as
   "" in that case (nothing to record) — the field only holds a
   real value for the historical case where an order was paid
   individually, kept for backward compatibility with old records.
   The atomic status:"created"->"paid" claim below still guards
   against this being called twice for the same order.
============================================================ */

const applyPaidLicenseOrder = async (orderId, { razorpayPaymentId, method } = {}) => {
  await claimPayment(razorpayPaymentId, `order:${orderId}`);
  // Atomic claim — only the caller that flips status first gets to apply
  // the licenses; a retried/duplicate call finds no matching document
  // (already "paid") and no-ops instead of double-crediting.
  const order = await ScreenLicensePurchaseOrder.findOneAndUpdate(
    { _id: orderId, status: "created" },
    {
      $set: {
        status: "paid",
        orderStatus: "completed",
        "razorpay.paymentId": razorpayPaymentId,
        "razorpay.method": method || ""
      }
    },
    { new: true }
  );

  if (!order) {
    // Already applied (or never existed) — safe no-op, mirrors
    // CustomerPayment's commissionGenerated guard.
    return null;
  }

  await resellerInventory.applyPurchase({
    partnerId: order.partnerId,
    quantity: order.quantity,
    purchaseOrderId: order._id
  });

  order.licensesApplied = true;
  await order.save();

  // This purchase becomes its own bill: its cycle starts today, and the
  // first cycle is invoiced straight away (it is charged in advance).
  try {
    await ensureOrderBilling(order, { startDate: new Date(), legacy: false });
    await generateInvoicesForOrder(order);
  } catch (error) {
    // The licences are already credited. The daily billing job raises the
    // invoice if this attempt failed, so the approval itself still stands.
    console.error("Failed to raise the first invoice after a license purchase:", error);
  }

  await logActivity({
    partnerId: order.partnerId,
    performedByType: "system",
    activityType: "license_purchased",
    entityType: "ScreenLicensePurchaseOrder",
    entityId: order._id,
    description: `${order.quantity} screen licenses purchased (order ${order.orderCode || order._id}).`
  });

  return order;
};

// Called by the Razorpay webhook when an online license payment fails —
// only an order still awaiting payment can be marked failed.
const markLicenseOrderFailed = async (orderId, { failureCode, failureReason } = {}) => {
  return ScreenLicensePurchaseOrder.findOneAndUpdate(
    { _id: orderId, status: "created" },
    {
      $set: {
        status: "failed",
        orderStatus: "payment_failed",
        "razorpay.failureCode": failureCode || "",
        "razorpay.failureReason": failureReason || "Payment failed."
      }
    },
    { returnDocument: "after" }
  );
};

module.exports = { applyPaidLicenseOrder, markLicenseOrderFailed };
