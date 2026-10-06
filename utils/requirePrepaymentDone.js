const ResellerBillingConfig = require("../models/ResellerBillingConfig");

/* ============================================================
   Shared gate: a Reseller can't buy licenses OR register a
   customer until their one-time prepayment is done (see
   ResellerBillingConfig.prepayment). Admin-set, not something the
   reseller can trigger or bypass. Returns null if the gate passes,
   or a { status, message } object to send back as a 403 if it
   doesn't — callers decide how to respond, this just decides.
============================================================ */

const requirePrepaymentDone = async (partnerId) => {
  const billingConfig = await ResellerBillingConfig.findOne({ partnerId });
  const prepaymentStatus = billingConfig?.prepayment?.status || "not_done";

  if (prepaymentStatus === "done") return null;

  return {
    status: 403,
    message: prepaymentStatus === "awaiting_payment"
      ? "Complete your one-time prepayment from the Billing page first."
      : "SPOTX needs to set up your one-time prepayment before you can do this. Contact SPOTX to get started."
  };
};

module.exports = requirePrepaymentDone;
