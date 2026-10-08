const mongoose = require("mongoose");
const { Customer, Partner, Invoice } = require("../models/Index");
const CustomerPayment = require("../models/CustomerPayment");
const { generateCommissionForCustomerPayment } = require("./commissionEngine");
const { refreshVendorScreenCount } = require("./tierAssignment");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;
// Every Mongoose write in each transaction shares its session, including
// the commission ledger, partner totals, activity and notification records.
mongoose.set("transactionAsyncLocalStorage", true);

const applyPaidCustomerPayment = async (customerPaymentId, { razorpayPaymentId, method }, { req } = {}) => {
  // Commit the paid subscription and receipt independently of commission.
  // A missing assignment must never roll back a captured customer payment.
  const first = await mongoose.connection.transaction(async () => {
    const claimed = await CustomerPayment.findOneAndUpdate(
      { _id: customerPaymentId, status: { $in: ["created", "failed"] } },
      { $set: { status: "paid", "razorpay.paymentId": razorpayPaymentId, "razorpay.method": method || "" } },
      { returnDocument: "after" }
    );
    if (!claimed) return null;
    const customer = await Customer.findById(claimed.customerId);
    if (!customer) throw new Error("Customer not found for captured payment.");
    Object.assign(customer.subscription, {
      status: "active", screenCount: claimed.screenCount, plan: claimed.plan,
      durationMonths: claimed.durationMonths, currentPeriodStart: claimed.period.start,
      currentPeriodEnd: claimed.period.end, scheduledChange: undefined
    });
    await customer.save();
    await Invoice.create({ customerId: customer._id, partnerId: claimed.partnerId,
      amount: claimed.amount.total, currency: claimed.amount.currency || "INR",
      status: "paid", issuedAt: new Date(), customerPaymentId: claimed._id });
    return claimed;
  });

  // Only the call that claimed the payment notifies, so a retry or the
  // webhook arriving after the browser callback doesn't post it twice.
  if (first) {
    const [customer, partner] = await Promise.all([
      Customer.findById(first.customerId).select("companyName"),
      Partner.findById(first.partnerId).select("partnerCode partnerType legalEntity.businessName primaryContact.name")
    ]);
    await notifyAdmins({
      type: "vendor_customer_payment",
      title: "Vendor customer payment received",
      message: `${customer?.companyName || "A customer"} of ${partnerLabel(partner)} paid ₹${Number(first.amount.total || 0).toLocaleString("en-IN")} for ${first.screenCount} screen${first.screenCount === 1 ? "" : "s"}.`,
      link: `/admin/partners/${first.partnerId}`,
      audienceRoles: ["finance"],
      partnerId: first.partnerId,
      entityType: "CustomerPayment",
      entityId: first._id
    });
  }

  const completed = await mongoose.connection.transaction(async () => {
    const payment = await CustomerPayment.findOne({ _id: customerPaymentId, status: "paid", commissionGenerated: { $ne: true } });
    if (!payment) return null;
    if (payment.razorpay.paymentId !== razorpayPaymentId) throw new Error("Captured payment reference does not match.");
    const customer = await Customer.findById(payment.customerId);
    if (!customer) throw new Error("Customer not found for commission recovery.");
    if (payment.amount.base > 0) {
      await generateCommissionForCustomerPayment({ customer, revenue: payment.amount.base, screenCount: payment.screenCount, req });
    }
    // Reload after commission generation so refreshing screen statistics
    // cannot overwrite the updated revenue and commission totals.
    const partner = await Partner.findById(payment.partnerId);
    if (!partner) throw new Error("Partner not found for commission recovery.");
    await refreshVendorScreenCount(partner);
    payment.commissionRecoveryError = "";
    payment.commissionGenerated = true;
    await payment.save();
    return { customerPayment: payment, customer };
  });
  return completed || (first ? { customerPayment: first, customer: await Customer.findById(first.customerId) } : null);
};

// Paid-but-unfinished records survive errors and restarts. Only commission
// is retried; the subscription and receipt are never reapplied.
const recoverPendingCustomerCommissions = async () => {
  const payments = await CustomerPayment.find({ status: "paid", commissionGenerated: { $ne: true } })
    .sort({ updatedAt: 1 }).limit(100).select("razorpay");
  for (const payment of payments) {
    try {
      await applyPaidCustomerPayment(payment._id, { razorpayPaymentId: payment.razorpay.paymentId, method: payment.razorpay.method });
    } catch (error) {
      await CustomerPayment.updateOne({ _id: payment._id }, { $set: { commissionRecoveryError: error.message } });
      console.error("Customer commission recovery failed:", String(payment._id), error.message);
    }
  }
};
module.exports = { applyPaidCustomerPayment, recoverPendingCustomerCommissions };
