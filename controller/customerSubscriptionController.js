const { Screen, ScreenPricing, Partner } = require("../models/Index");
const CustomerPayment = require("../models/CustomerPayment");
const { applyPaidCustomerPayment } = require("../services/customerPaymentFulfillment");
const { SUBSCRIPTION_DURATIONS, GST_RATE_PERCENT } = require("../config/constant");
const { fetchPaymentById, createOrder, verifyPaymentSignature, RazorpayLookupError } = require("../utils/razorpay");

/* ============================================================
   CUSTOMER — SUBSCRIPTION (SELF-SERVICE CHECKOUT)
   Customer picks a plan, screen count, and a prepaid term length
   (1/3/6/12 months — SUBSCRIPTION_DURATIONS). If anything is owed,
   GST is added on top of the base amount and a Razorpay Order is
   created for the GST-inclusive total; the frontend opens Razorpay's
   own Checkout popup against that order, where the customer picks
   UPI/card/netbanking/etc themselves. Nothing is activated off the
   client's word alone — the popup's result is verified two
   independent ways (HMAC signature, then a fetchPaymentById
   re-check that it's actually captured for the right amount) before
   the subscription change and partner commission are applied, via
   the shared services/customerPaymentFulfillment. A $0 change (e.g.
   a deferred downgrade, or a same-cost lateral change) skips
   Razorpay entirely.

   Billing cycle / proration: a subscription runs on a
   (durationMonths × 30-day) currentPeriodStart -> currentPeriodEnd
   window.
   - Upgrade (or same-cost lateral change) mid-cycle AT THE SAME
     durationMonths: applies right away, charging only the prorated
     difference for the days left in the window — the window itself
     does NOT reset.
   - Downgrade mid-cycle AT THE SAME durationMonths: does NOT apply
     right away. They already paid for the pricier plan this cycle,
     so they keep it (and aren't charged anything more) until
     currentPeriodEnd, at which point the downgrade takes effect —
     see scheduledChange below.
   - Picking a DIFFERENT durationMonths than what's currently active
     is always treated as starting a fresh prepaid term right now —
     full price for the newly chosen term, window resets from today.
     Keeps the proration math from having to reconcile two
     differently-sized windows; no credit for unused time either way,
     same "no refund" spirit as a same-duration downgrade.
   - A change requested once the window has lapsed is charged in
     full and opens a fresh window.

   There's no scheduler to auto-renew or auto-apply a scheduled
   downgrade at currentPeriodEnd; materializeScheduledChangeIfDue
   applies it lazily the next time the customer's subscription is
   touched (viewed or changed) on or after that date — same "lazy,
   no cron" spirit as everything else in this billing flow.
============================================================ */

const PLAN_PRICE_FIELD = { basic: "basicPricePerScreen", premium: "premiumPricePerScreen" };
const CYCLE_DAYS = 30;
// How long a still-unpaid order is treated as reusable for the exact same
// change (see createCheckoutOrder) — long enough to survive a closed/
// reopened confirm dialog or a double-tapped Pay button, short enough that
// a genuinely abandoned attempt doesn't get resurrected hours later.
const ORDER_REUSE_WINDOW_MS = 30 * 60 * 1000;
// Razorpay's own floor for a chargeable order (100 paise = ₹1).
const RAZORPAY_MIN_AMOUNT_PAISE = 100;

const round2 = (n) => Math.round(n * 100) / 100;

const getPricing = async () => {
  let pricing = await ScreenPricing.findOne();
  if (!pricing) pricing = await ScreenPricing.create({});
  return pricing;
};

const materializeScheduledChangeIfDue = async (customer) => {
  const { subscription } = customer;

  if (!subscription.scheduledChange?.plan || !subscription.currentPeriodEnd) return;
  if (new Date() < new Date(subscription.currentPeriodEnd)) return;

  subscription.plan = subscription.scheduledChange.plan;
  subscription.screenCount = subscription.scheduledChange.screenCount;
  subscription.durationMonths = subscription.scheduledChange.durationMonths || 1;
  subscription.scheduledChange = undefined;
  await customer.save();
};

// Pure so the frontend can mirror it for a live preview before submitting —
// the server recomputes with its own clock and DB state as the
// authoritative source when actually charging.
const computeChange = (subscription, pricing, plan, screenCount, durationMonths, now = new Date()) => {
  const newPricePerScreen = pricing[PLAN_PRICE_FIELD[plan]] || 0;
  const fullAmount = screenCount * newPricePerScreen * durationMonths;
  const periodDays = CYCLE_DAYS * durationMonths;

  const hasOpenCycle = subscription.status === "active"
    && subscription.currentPeriodEnd
    && now < new Date(subscription.currentPeriodEnd);

  // A different term length than what's currently active always starts a
  // fresh prepaid term right now — only a same-duration plan/screen change
  // gets prorated against the time left on the current cycle.
  const sameDuration = hasOpenCycle && (subscription.durationMonths || 1) === durationMonths;

  if (!hasOpenCycle || !sameDuration) {
    return {
      type: "immediate",
      amount: fullAmount,
      prorated: false,
      fullAmount,
      periodStart: now,
      periodEnd: new Date(now.getTime() + periodDays * 24 * 60 * 60 * 1000)
    };
  }

  const currentPricePerScreen = pricing[PLAN_PRICE_FIELD[subscription.plan]] || 0;
  const currentTotal = currentPricePerScreen * (subscription.screenCount || 0) * durationMonths;
  const periodEnd = new Date(subscription.currentPeriodEnd);

  if (fullAmount < currentTotal) {
    // Downgrade — deferred to periodEnd, nothing charged now, current
    // plan/screenCount/period are left completely untouched.
    return { type: "deferred", amount: 0, prorated: false, fullAmount, periodEnd };
  }

  // Upgrade or same-cost lateral change — apply now, prorate the diff.
  const periodStart = new Date(subscription.currentPeriodStart);
  const totalMs = periodEnd - periodStart;
  const remainingMs = periodEnd - now;
  const remainingFraction = totalMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalMs)) : 0;

  const proratedDiff = Math.round((fullAmount - currentTotal) * remainingFraction * 100) / 100;

  return { type: "immediate", amount: Math.max(0, proratedDiff), prorated: true, fullAmount, periodStart, periodEnd };
};

// Layers GST on top of computeChange's base amount — kept separate so the
// proration math above stays exactly as it was before Razorpay checkout
// existed. gst/total are computed off `amount` (what's actually due now),
// not fullAmount (the reference full-term price shown for context).
const withGst = (change) => {
  const gst = round2((change.amount * GST_RATE_PERCENT) / 100);
  return { ...change, gstRatePercent: GST_RATE_PERCENT, gst, total: round2(change.amount + gst) };
};

const getSubscription = async (req, res) => {
  await materializeScheduledChangeIfDue(req.customer);

  const [registeredScreenCount, pricing] = await Promise.all([
    Screen.countDocuments({ customerId: req.customer._id }),
    getPricing()
  ]);

  return res.json({
    success: true,
    data: {
      subscription: req.customer.subscription,
      trial: req.customer.trial,
      trialExpired: req.customer.trialExpired,
      registeredScreenCount,
      plans: {
        basic: pricing.basicPricePerScreen,
        premium: pricing.premiumPricePerScreen
      },
      durations: SUBSCRIPTION_DURATIONS,
      gstRatePercent: GST_RATE_PERCENT
    }
  });
};

const validatePlanRequest = (req, res) => {
  const screenCount = Number(req.body.screenCount);
  const durationMonths = Number(req.body.durationMonths);
  const { plan } = req.body;

  if (!Number.isInteger(screenCount) || screenCount < 1) {
    res.status(400).json({ success: false, message: "Enter a valid number of screens (at least 1)." });
    return null;
  }

  if (!PLAN_PRICE_FIELD[plan]) {
    res.status(400).json({ success: false, message: "Choose a valid plan (basic or premium)." });
    return null;
  }

  if (!SUBSCRIPTION_DURATIONS.includes(durationMonths)) {
    res.status(400).json({ success: false, message: "Choose a valid subscription term (1, 3, 6, or 12 months)." });
    return null;
  }

  return { screenCount, durationMonths, plan };
};

const applyImmediateFreeChange = async (customer, plan, screenCount, durationMonths, change) => {
  customer.subscription.status = "active";
  customer.subscription.screenCount = screenCount;
  customer.subscription.plan = plan;
  customer.subscription.durationMonths = durationMonths;
  customer.subscription.currentPeriodStart = change.periodStart;
  customer.subscription.currentPeriodEnd = change.periodEnd;
  customer.subscription.scheduledChange = undefined;
  await customer.save();
};

// Step 1 of checkout: recompute the change server-side (never trust the
// client for money), and either apply it immediately (deferred downgrade,
// or nothing actually due) or open a Razorpay Order for the GST-inclusive
// total and hand back what the frontend needs to launch Checkout.
const createCheckoutOrder = async (req, res) => {
  try {
    const parsed = validatePlanRequest(req, res);
    if (!parsed) return;
    const { screenCount, durationMonths, plan } = parsed;

    const pricing = await getPricing();
    const customer = req.customer;
    await materializeScheduledChangeIfDue(customer);

    const change = withGst(computeChange(customer.subscription, pricing, plan, screenCount, durationMonths));

    if (change.type === "deferred") {
      customer.subscription.scheduledChange = { plan, screenCount, durationMonths };
      await customer.save();

      return res.json({
        success: true,
        requiresPayment: false,
        message: `You'll switch to the ${plan} plan (${screenCount} screens, ${durationMonths}-month term) on ${change.periodEnd.toLocaleDateString("en-IN")} — you keep your current plan until then, and there's no charge today.`,
        data: { subscription: customer.subscription }
      });
    }

    if (change.total <= 0) {
      await applyImmediateFreeChange(customer, plan, screenCount, durationMonths, change);

      return res.json({
        success: true,
        requiresPayment: false,
        message: `Subscribed to the ${plan} plan for ${screenCount} screens, ${durationMonths}-month term.`,
        data: { subscription: customer.subscription }
      });
    }

    if (Math.round(change.total * 100) < RAZORPAY_MIN_AMOUNT_PAISE) {
      return res.status(400).json({ success: false, message: "The amount due is below Razorpay's minimum chargeable amount (₹1)." });
    }

    const partner = await Partner.findById(customer.partnerId);
    if (!partner) {
      return res.status(400).json({ success: false, message: "No partner is associated with this customer account." });
    }

    const prefill = {
      name: customer.contactName || customer.companyName,
      email: customer.email,
      contact: customer.phone || ""
    };

    // Reuse a still-payable order already opened for this exact change
    // recently, instead of opening a fresh Razorpay order every time —
    // otherwise reopening the confirm dialog or double-tapping Pay litters
    // the Razorpay dashboard with duplicate orders for the same charge.
    const reusable = await CustomerPayment.findOne({
      customerId: customer._id,
      plan,
      screenCount,
      durationMonths,
      "amount.total": change.total,
      status: { $ne: "paid" },
      "razorpay.orderId": { $exists: true, $ne: null },
      createdAt: { $gte: new Date(Date.now() - ORDER_REUSE_WINDOW_MS) }
    }).sort({ createdAt: -1 });

    if (reusable) {
      return res.json({
        success: true,
        requiresPayment: true,
        data: {
          customerPaymentId: reusable._id,
          orderId: reusable.razorpay.orderId,
          amount: change.total,
          currency: "INR",
          keyId: process.env.RAZORPAY_KEY_ID,
          breakdown: { base: change.amount, gstRatePercent: change.gstRatePercent, gst: change.gst, total: change.total },
          prefill
        }
      });
    }

    const customerPayment = await CustomerPayment.create({
      customerId: customer._id,
      partnerId: partner._id,
      plan,
      screenCount,
      durationMonths,
      changeType: change.type,
      prorated: change.prorated,
      amount: {
        base: change.amount,
        gstRatePercent: change.gstRatePercent,
        gst: change.gst,
        total: change.total,
        currency: "INR"
      },
      period: { start: change.periodStart, end: change.periodEnd }
    });

    const order = await createOrder({
      amountInRupees: change.total,
      receipt: customerPayment._id.toString(),
      notes: {
        customerId: customer._id.toString(),
        plan,
        screenCount: String(screenCount),
        durationMonths: String(durationMonths)
      }
    });

    customerPayment.razorpay.orderId = order.id;
    await customerPayment.save();

    return res.json({
      success: true,
      requiresPayment: true,
      data: {
        customerPaymentId: customerPayment._id,
        orderId: order.id,
        amount: change.total,
        currency: "INR",
        keyId: process.env.RAZORPAY_KEY_ID,
        breakdown: { base: change.amount, gstRatePercent: change.gstRatePercent, gst: change.gst, total: change.total },
        prefill
      }
    });
  } catch (error) {
    console.error("createCheckoutOrder error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong starting checkout." });
  }
};

// Step 2 of checkout: called by the customer's browser right after the
// Razorpay Checkout popup reports success. Verifies the HMAC signature,
// re-fetches the payment from Razorpay to confirm it's actually captured
// for the right amount against the right order, and only then hands off
// to the shared fulfillment path (which is itself idempotent against the
// webhook safety net also reaching the same payment).
const verifyCheckoutPayment = async (req, res) => {
  try {
    const { customerPaymentId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body;

    if (!customerPaymentId || !orderId || !paymentId || !signature) {
      return res.status(400).json({ success: false, message: "Missing payment verification details." });
    }

    const customerPayment = await CustomerPayment.findOne({ _id: customerPaymentId, customerId: req.customer._id });
    if (!customerPayment) {
      return res.status(404).json({ success: false, message: "Payment record not found." });
    }

    if (customerPayment.status === "paid" && customerPayment.commissionGenerated) {
      // Already fulfilled (e.g. the webhook beat this call to it) — treat
      // as success rather than erroring the customer over a race.
      return res.json({ success: true, message: "Payment already confirmed.", data: { subscription: req.customer.subscription } });
    }

    if (customerPayment.razorpay.orderId !== orderId) {
      return res.status(400).json({ success: false, message: "This payment attempt is no longer valid — please start again." });
    }

    // A "failed" status here just means an earlier method attempt on THIS
    // SAME order was declined — Razorpay Checkout lets the customer retry
    // with a different method without closing the popup, so a prior
    // failure must not block this (possibly successful) one.

    if (!(await verifyPaymentSignature({ orderId, paymentId, signature }))) {
      if (customerPayment.status !== "paid") {
        customerPayment.status = "failed";
        customerPayment.razorpay.failureReason = "Signature verification failed.";
        await customerPayment.save();
      }
      return res.status(400).json({ success: false, message: "Payment could not be verified. If any amount was debited, it will be refunded automatically by Razorpay." });
    }

    const payment = await fetchPaymentById(paymentId);
    const expectedPaise = Math.round(customerPayment.amount.total * 100);

    if (payment.status !== "captured" || payment.order_id !== orderId || payment.amount !== expectedPaise) {
      customerPayment.status = "failed";
      customerPayment.razorpay.failureReason = `Razorpay payment check failed (status: ${payment.status}).`;
      await customerPayment.save();
      return res.status(400).json({ success: false, message: "This payment couldn't be confirmed as captured for the correct amount." });
    }

    const result = await applyPaidCustomerPayment(customerPayment._id, { razorpayPaymentId: paymentId, method: payment.method }, { req });

    if (!result || !result.customer) {
      return res.json({ success: true, message: "Payment already confirmed.", data: { subscription: req.customer.subscription } });
    }

    return res.json({
      success: true,
      message: `Payment successful — subscribed to the ${customerPayment.plan} plan for ${customerPayment.screenCount} screens, ${customerPayment.durationMonths}-month term.`,
      data: { subscription: result.customer.subscription, transactionId: paymentId, amountPaid: customerPayment.amount.total }
    });
  } catch (error) {
    if (error instanceof RazorpayLookupError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error("verifyCheckoutPayment error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong confirming your payment. Contact support with your payment ID if any amount was debited." });
  }
};

// Best-effort record of a declined/abandoned Checkout attempt (card
// declined, OTP wrong, popup closed, etc) — purely for DB record-keeping
// and admin visibility. No money moved, so nothing here needs to be
// trusted; it never activates anything. Only skips a row already "paid" —
// Checkout lets the customer retry a different method on the same order
// after a decline, so this can fire more than once against one row before
// it's eventually claimed by verifyCheckoutPayment/the webhook.
const recordCheckoutFailure = async (req, res) => {
  try {
    const { customerPaymentId, code, description } = req.body;

    const customerPayment = await CustomerPayment.findOne({ _id: customerPaymentId, customerId: req.customer._id });
    if (!customerPayment || customerPayment.status === "paid") {
      return res.json({ success: true });
    }

    customerPayment.status = "failed";
    customerPayment.razorpay.failureCode = code || "";
    customerPayment.razorpay.failureReason = description || "Payment was not completed.";
    await customerPayment.save();

    return res.json({ success: true });
  } catch (error) {
    console.error("recordCheckoutFailure error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong." });
  }
};

module.exports = { getSubscription, createCheckoutOrder, verifyCheckoutPayment, recordCheckoutFailure };
