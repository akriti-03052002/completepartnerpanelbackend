const ResellerInvoice = require("../models/ResellerInvoice");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");

/* ============================================================
   BLOCK IF RESELLER PAYMENT RESTRICTED
   Resolved enforcement scope: panel-access restriction ONLY, permanently — this
   system has no link to the Reseller's hardware/CMS at all, so
   there is no mechanism to reach further than this, and none
   should be built. A partner past their grace period loses the
   ability to allocate, register, activate, or purchase — already-
   running screens are untouched, since this system has no way to
   touch them either way.

   Mounted only on the specific mutating routes that should be
   blocked (see partnerResellerRoutes.js) — read-only routes and
   the invoice-payment route itself stay open so a restricted
   partner can still see their situation and pay their way out of it.
============================================================ */

const blockIfResellerPaymentRestricted = async (req, res, next) => {
  try {
    const overdueInvoice = await ResellerInvoice.findOne({
      partnerId: req.partner._id,
      paymentStatus: "overdue"
    }).sort({ dueDate: 1 });

    if (!overdueInvoice) return next();

    const config = await ResellerBillingConfig.findOne({ partnerId: req.partner._id });
    const gracePeriodDays = config?.gracePeriodDays ?? 3;
    const restrictionStartsAt = new Date(overdueInvoice.dueDate.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);

    if (new Date() < restrictionStartsAt) return next();

    return res.status(403).json({
      success: false,
      restricted: true,
      message: `Your account is restricted due to an unpaid invoice (${overdueInvoice.invoiceNumber}). Pay it to restore access to purchases and allocations.`
    });
  } catch (error) {
    console.error("blockIfResellerPaymentRestricted error:", error);
    // Fail open on an infrastructure error — never lock a partner out
    // because of a bug in the restriction check itself.
    return next();
  }
};

module.exports = blockIfResellerPaymentRestricted;
