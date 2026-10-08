const mongoose = require("mongoose");
const { Customer, Partner, Invoice, Screen } = require("../models/Index");
const { generateCommissionForCustomerPayment } = require("../services/commissionEngine");
const { refreshVendorScreenCount } = require("../services/tierAssignment");
const { sendCustomerSetPasswordEmail } = require("../services/customerAuth");
const logActivity = require("../utils/logActivity");
const notifyPartner = require("../utils/notifyPartner");
const { SUBSCRIPTION_DURATIONS } = require("../config/constant");

const CYCLE_DAYS = 30;

/* ============================================================
   ADMIN — CUSTOMERS (VENDOR'S END CUSTOMERS)
   Cross-vendor view for SPOTX staff: track trial/paid status
   and, since there's no live payment gateway wired up yet,
   manually confirm payment (which is also what generates the
   vendor's recurring commission on that customer).
============================================================ */

const listCustomers = async (req, res) => {
  const { partnerId, status } = req.query;

  const filter = {};
  if (partnerId) filter.partnerId = partnerId;
  if (status) filter["subscription.status"] = status;

  const customers = await Customer.find(filter)
    .select("+auth.passwordHash")
    .sort({ createdAt: -1 })
    .populate("partnerId", "partnerCode legalEntity.businessName");
  const screenCounts = await Screen.aggregate([
    { $match: { customerId: { $in: customers.map(customer => customer._id) } } },
    { $group: { _id: "$customerId", count: { $sum: 1 } } }
  ]);
  const registeredCounts = new Map(screenCounts.map(row => [String(row._id), row.count]));


  // auth.passwordHash is select:false by default (never sent to the client) —
  // it's pulled in here only to derive this boolean, then stripped back out.
  const data = customers.map((customer) => {
    const plain = customer.toObject();
    const hasPassword = Boolean(customer.auth?.passwordHash);
    delete plain.auth;
    plain.auth = { hasPassword };
    plain.registeredScreens = registeredCounts.get(String(customer._id)) || 0;
    plain.subscribedScreens = Number(customer.subscription?.screenCount) || 0;
    return plain;
  });

  return res.json({ success: true, data });
};

const markCustomerPaid = async (req, res) => {
  try {
    const { revenue, screenCount, plan, durationMonths } = req.body;
    const paymentReference = String(req.body.paymentReference || "").trim().toUpperCase();
    if (!paymentReference || paymentReference.length > 128) return res.status(400).json({ success: false, message: "Enter the payment transaction reference or cash receipt number (up to 128 characters)." });

    if (!revenue || revenue <= 0) {
      return res.status(400).json({ success: false, message: "A positive revenue amount is required to mark payment received." });
    }

    if (plan && !["basic", "premium"].includes(plan)) {
      return res.status(400).json({ success: false, message: "Plan must be basic or premium." });
    }

    if (durationMonths !== undefined && !SUBSCRIPTION_DURATIONS.includes(Number(durationMonths))) {
      return res.status(400).json({ success: false, message: "Duration must be 1, 3, 6, or 12 months." });
    }

    const customer = await mongoose.connection.transaction(async session => {
      const customer = await Customer.findById(req.params.id).session(session);

      if (!customer) {
        throw Object.assign(new Error("Customer not found."), { status: 404 });
      }

      customer.subscription.status = "active";
      if (screenCount !== undefined) customer.subscription.screenCount = Number(screenCount) || 0;
      // Falls back to whatever plan they were already on (e.g. re-confirming
      // a payment for an existing subscriber) rather than clearing it, since
      // this field isn't collected on every admin action that touches status.
      if (plan) customer.subscription.plan = plan;

      // Opens/extends a fresh billing cycle the same length as a self-service
      // purchase would (see customerSubscriptionController.computeChange) —
      // this is the manual fallback for the same flow, just admin-confirmed
      // instead of Razorpay-verified.
      const resolvedDuration = durationMonths !== undefined ? Number(durationMonths) : (customer.subscription.durationMonths || 1);
      customer.subscription.durationMonths = resolvedDuration;
      customer.subscription.currentPeriodStart = new Date();
      customer.subscription.currentPeriodEnd = new Date(Date.now() + CYCLE_DAYS * resolvedDuration * 24 * 60 * 60 * 1000);

      await customer.save({ session });

      // Same receipt a self-service checkout produces, so the customer's
      // Billing page shows this payment too.
      await Invoice.create([{
        customerId: customer._id,
        partnerId: customer.partnerId,
        amount: Number(revenue),
        currency: "INR",
        status: "paid",
        issuedAt: new Date(),
        manualPaymentReference: paymentReference
      }], { session });

      return customer;
    });

    let commission, skipped;
    try {
      ({ commission, skipped } = await generateCommissionForCustomerPayment({
        customer,
        revenue: Number(revenue),
        screenCount: customer.subscription.screenCount,
        req,
        adminUser: req.adminUser
      }));
    } catch {
      return res.json({ success: true, message: "Payment and invoice recorded. Commission processing failed; contact finance to review it. Do not record this payment again.", data: { customer, commission: null } });
    }

    const partner = await Partner.findById(customer.partnerId);
    if (partner) await refreshVendorScreenCount(partner);

    const message = commission
      ? "Payment recorded and commission generated."
      : skipped === "recurring_period_ended"
        ? "Payment recorded. No commission: the vendor's recurring commission period for this customer has ended."
        : "Payment recorded. No new commission: the vendor's one-time commission for this customer was already earned on their first payment.";
    return res.json({ success: true, message, data: { customer, commission } });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ success: false, message: "This payment reference has already been recorded. No new invoice was created." });
    console.error("markCustomerPaid error:", error);
    return res.status(error.status || 400).json({ success: false, message: error.message || "Something went wrong recording payment." });
  }
};

const cancelCustomerSubscription = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }

    customer.subscription.status = "cancelled";
    await customer.save();

    const partner = await Partner.findById(customer.partnerId);
    if (partner) await refreshVendorScreenCount(partner);

    await logActivity({
      partnerId: customer.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "Customer",
      entityId: customer._id,
      description: `${req.adminUser.name} cancelled ${customer.companyName}'s subscription.`,
      req
    });

    await notifyPartner({
      partnerId: customer.partnerId,
      type: "customer_subscription_cancelled",
      title: "A customer's subscription was cancelled",
      message: `${customer.companyName}'s SPOTX subscription was cancelled.`,
      entityType: "Customer",
      entityId: customer._id
    });

    return res.json({ success: true, message: "Subscription cancelled.", data: customer });
  } catch (error) {
    console.error("cancelCustomerSubscription error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong cancelling the subscription." });
  }
};

const markCustomerExpired = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id);

    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }

    customer.subscription.status = "expired";
    await customer.save();

    const partner = await Partner.findById(customer.partnerId);
    if (partner) await refreshVendorScreenCount(partner);

    await logActivity({
      partnerId: customer.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "Customer",
      entityId: customer._id,
      description: `${req.adminUser.name} marked ${customer.companyName}'s subscription expired.`,
      req
    });

    await notifyPartner({
      partnerId: customer.partnerId,
      type: "customer_subscription_expired",
      title: "A customer's subscription expired",
      message: `${customer.companyName}'s SPOTX subscription has expired. They can renew from their own panel.`,
      entityType: "Customer",
      entityId: customer._id
    });

    return res.json({ success: true, message: "Subscription marked expired.", data: customer });
  } catch (error) {
    console.error("markCustomerExpired error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong updating the subscription." });
  }
};

// Re-sends the set-password email for a customer who hasn't set one yet.
// Admin-only — a partner shouldn't have visibility into their customers'
// login credentials, and neither the partner nor an admin ever sets or sees
// the actual password (see services/customerAuth.sendCustomerSetPasswordEmail).
// Only valid while the customer has no password yet; once they've set one,
// this becomes a no-op path — they use the normal forgot-password flow instead.
const resetCustomerCredentials = async (req, res) => {
  try {
    const customer = await Customer.findById(req.params.id).select("+auth.passwordHash");

    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }

    if (customer.auth.passwordHash) {
      return res.status(400).json({ success: false, message: "This customer has already set their password." });
    }

    await sendCustomerSetPasswordEmail(customer, { isNewAccount: true });

    await logActivity({
      partnerId: customer.partnerId,
      performedByType: "spotx_user",
      performedByUserId: req.adminUser._id,
      activityType: "note",
      entityType: "Customer",
      entityId: customer._id,
      description: `${req.adminUser.name} re-sent the set-password email for ${customer.companyName}.`,
      req
    });

    return res.json({
      success: true,
      message: `Set-password email sent to ${customer.email}.`
    });
  } catch (error) {
    console.error("resetCustomerCredentials error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong sending the email." });
  }
};

module.exports = { listCustomers, markCustomerPaid, cancelCustomerSubscription, markCustomerExpired, resetCustomerCredentials };
