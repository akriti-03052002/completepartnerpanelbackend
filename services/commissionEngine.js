const { CommissionRule, PartnerCommission, Partner, PartnerNotification, PartnerBankAccount } = require("../models/Index");
const logActivity = require("../utils/logActivity");
const { findApplicableCommissionRule } = require("../utils/partnerCommissionResolver");

// No commission is created — not held, not pending, nothing — for a
// partner whose payout bank account hasn't cleared both the automated
// Razorpay check and the admin's final review (see
// adminBankController.verifyBankAccount, the only place this flips to
// "eligible"). Settlement-holding (utils/settlementHold.js) is a separate,
// later concern about *paying out* already-generated commission — this is
// about not generating it in the first place.
const assertCommissionEligible = async (partner) => {
  const bankAccount = await PartnerBankAccount.findOne({ partnerId: partner._id });
  if (!bankAccount || bankAccount.commissionEligibility !== "eligible") {
    throw new Error("This partner's bank account isn't verified and commission-eligible yet — verify it before marking deals/payments as won.");
  }
};

/* ============================================================
   COMMISSION ENGINE
   Runs when an admin marks a PartnerOpportunity "won". Picks the
   active CommissionRule for the partner's current tier (falls
   back to a tier-less/generic rule if the partner has no tier),
   computes the commission, writes the ledger row, and bumps the
   partner's cached stats.

   One payment shape needs special handling here:
   - Affiliate/Influencer optional recurring add-on: a SECOND rule
     (CommissionRule.isAddOn = true, scoped by partnerType, not tied to
     any tier) that the admin chooses to apply per-deal, not something
     that fires automatically.

   KNOWN LIMITATION: for commissionType starting with "recurring_",
   this only creates the FIRST cycle. There's no scheduler yet to
   auto-generate renewal cycles (cycleNumber 2, 3, ...) — that
   would need a cron job, which is out of scope for this pass.
============================================================ */

const computeGrossCommission = (rule, revenue, screenCount) => {
  switch (rule.commissionType) {
    case "percentage":
    case "recurring_percentage":
      return (revenue * (rule.rate || 0)) / 100;

    case "fixed_per_deal":
    case "recurring_fixed":
      return rule.fixedAmount || 0;

    case "fixed_per_screen":
      return (rule.perScreenAmount || 0) * (screenCount || 0);

    case "hybrid": {
      const percentPart = (revenue * (rule.hybrid?.percentageRate || 0)) / 100;
      const fixedPart = rule.hybrid?.fixedAmount || 0;
      const screenPart = (rule.hybrid?.perScreenAmount || 0) * (screenCount || 0);
      return percentPart + fixedPart + screenPart;
    }

    default:
      return 0;
  }
};

const isRecurringType = (rule) => String(rule.commissionType || "").startsWith("recurring_");

// Has a recurring rule's limited period (N months / years from the
// customer's first commission) run out? No limit set means for life.
const recurringWindowEnded = (rule, firstEarnedAt, now = new Date()) => {
  const { durationType, duration } = rule.recurring || {};
  if (!duration || !["months", "years"].includes(durationType)) return false;
  const end = new Date(firstEarnedAt);
  if (durationType === "months") end.setMonth(end.getMonth() + duration);
  else end.setFullYear(end.getFullYear() + duration);
  return now >= end;
};

const computeExpiryFromRecurring = (rule) => {
  if (!rule.recurring?.enabled || !rule.recurring.duration) return undefined;

  const expiry = new Date();
  if (rule.recurring.durationType === "months") expiry.setMonth(expiry.getMonth() + rule.recurring.duration);
  else if (rule.recurring.durationType === "years") expiry.setFullYear(expiry.getFullYear() + rule.recurring.duration);
  else return undefined;

  return expiry;
};

// A vendor-specific PartnerCommissionAssignment (admin-set custom
// commission) always wins over the shared tier ladder — see
// utils/partnerCommissionResolver.js. Non-vendor partner types never
// have one, so this is a no-op for them.
const findRuleForPartner = findApplicableCommissionRule;

const createCommissionRow = async ({ partner, opportunityId, customerId, rule, revenue, screenCount, cycleNumber, parentCommissionId }) => {
  const grossCommission = computeGrossCommission(rule, revenue, screenCount);
  const isRecurring = isRecurringType(rule);

  // rule may be a PartnerCommissionAssignment instead of a CommissionRule
  // (see findRuleForPartner) — commissionRuleId's ref only resolves
  // CommissionRule documents, so it's left unset rather than pointing at
  // the wrong collection; the actual terms used are already captured
  // in full below under `calculation`.
  const commission = await PartnerCommission.create({
    partnerId: partner._id,
    opportunityId: opportunityId || undefined,
    customerId: customerId || undefined,
    commissionRuleId: rule.constructor?.modelName === "CommissionRule" ? rule._id : undefined,
    transaction: { revenue, screenCount, currency: "INR" },
    calculation: {
      commissionType: rule.commissionType,
      rate: rule.rate || 0,
      fixedAmount: rule.fixedAmount || 0,
      grossCommission,
      deductions: 0,
      netCommission: grossCommission
    },
    recurring: {
      isRecurring,
      cycleNumber: cycleNumber || 1,
      parentCommissionId: parentCommissionId || undefined,
      expiresAt: computeExpiryFromRecurring(rule)
    },
    settlement: {
      eligibleAt: new Date(),
      status: "pending"
    }
  });

  partner.stats.totalCommission += grossCommission;
  partner.stats.pendingCommission += grossCommission;

  return { commission };
};

const generateCommissionForWonOpportunity = async ({ opportunity, revenue, screenCount, applyAddOn, req, adminUser }) => {
  const partner = await Partner.findById(opportunity.partnerId);

  if (!partner) {
    throw new Error("Partner not found for this opportunity.");
  }

  await assertCommissionEligible(partner);

  const rule = await findRuleForPartner(partner);

  if (!rule) {
    throw new Error(
      "No active commission assignment is configured for this partner. Assign their commission before marking deals won."
    );
  }

  partner.stats.wonDeals += 1;
  partner.stats.totalRevenue += revenue;

  const { commission } = await createCommissionRow({
    partner,
    opportunityId: opportunity._id,
    customerId: opportunity.customerId,
    rule,
    revenue,
    screenCount
  });

  let addOnCommission = null;

  if (applyAddOn) {
    const addOnRule = await CommissionRule.findOne({
      partnerType: partner.partnerType,
      isAddOn: true,
      status: "active"
    });

    if (addOnRule) {
      const result = await createCommissionRow({
        partner,
        opportunityId: opportunity._id,
        customerId: opportunity.customerId,
        rule: addOnRule,
        revenue,
        screenCount,
        parentCommissionId: commission._id
      });
      addOnCommission = result.commission;
    }
  }

  await partner.save();

  await logActivity({
    partnerId: partner._id,
    performedByType: "spotx_user",
    performedByUserId: adminUser._id,
    activityType: "commission_created",
    entityType: "PartnerCommission",
    entityId: commission._id,
    description: `Commission of ${commission.calculation.netCommission.toFixed(2)} generated for a won deal.`,
    req
  });

  await PartnerNotification.create({
    partnerId: partner._id,
    type: "commission_created",
    title: "Commission earned",
    message: `You earned ${commission.calculation.netCommission.toFixed(2)} commission on a won deal.`,
    entity: { type: "PartnerCommission", entityId: commission._id }
  });

  if (addOnCommission) {
    await PartnerNotification.create({
      partnerId: partner._id,
      type: "commission_created",
      title: "Recurring add-on applied",
      message: `An extra ${addOnCommission.calculation.netCommission.toFixed(2)} recurring add-on was applied to this deal.`,
      entity: { type: "PartnerCommission", entityId: addOnCommission._id }
    });
  }

  return { commission, addOnCommission };
};

/* ============================================================
   Vendor-only path: fires whenever a Customer's subscription is
   paid — either an admin marking it via adminCustomerController.
   markCustomerPaid, or the customer's own Razorpay checkout (see
   services/customerPaymentFulfillment.applyPaidCustomerPayment;
   adminUser is undefined there since no admin is involved).
   Commission is worked out PER CUSTOMER on what that customer paid
   (before GST): e.g. 50 screens at Rs.999 = Rs.49,950, at 10% =
   Rs.4,995. Whether the vendor earns that once (on the customer's
   first payment only) or on every payment depends on the commission
   type — see the one-time / recurring note inside. Returns { commission: null, skipped } when this
   payment earns nothing.
============================================================ */
const generateCommissionForCustomerPayment = async ({ customer, revenue, screenCount, req, adminUser }) => {
  const partner = await Partner.findById(customer.partnerId);

  if (!partner) {
    throw new Error("Partner not found for this customer.");
  }

  await assertCommissionEligible(partner);

  const rule = await findRuleForPartner(partner);

  if (!rule) {
    throw new Error(
      "No active commission assignment is configured for this vendor. Assign their commission before marking payment received."
    );
  }

  // ONE-TIME vs RECURRING.
  // A ONE-TIME type (percentage, fixed per customer, per screen, hybrid)
  // is earned ONCE per customer, on that customer's FIRST payment: 10% of
  // a first payment of Rs.49,950 (50 screens at Rs.999) = Rs.4,995.
  // Nothing after that earns again — not a renewal, and not screens the
  // customer adds later.
  // A RECURRING type is earned on every payment, for as long as the rule
  // says (N months / years from the first one, or for life).
  // A commission that was reversed doesn't count as having been earned.
  const earlier = await PartnerCommission.find({
    partnerId: partner._id,
    customerId: customer._id,
    "settlement.status": { $ne: "cancelled" }
  }).sort({ createdAt: 1 }).select("createdAt");
  const priorCycles = earlier.length;

  partner.stats.totalRevenue += revenue;

  let skipped = "";
  if (priorCycles > 0) {
    if (!isRecurringType(rule)) skipped = "one_time_already_earned";
    else if (recurringWindowEnded(rule, earlier[0].createdAt)) skipped = "recurring_period_ended";
  }
  if (skipped) {
    await partner.save();
    return { commission: null, skipped };
  }

  const { commission } = await createCommissionRow({
    partner,
    customerId: customer._id,
    rule,
    revenue,
    screenCount,
    cycleNumber: priorCycles + 1
  });

  await partner.save();

  await logActivity({
    partnerId: partner._id,
    performedByType: adminUser ? "spotx_user" : "system",
    performedByUserId: adminUser?._id,
    activityType: "commission_created",
    entityType: "PartnerCommission",
    entityId: commission._id,
    description: `Commission of ${commission.calculation.netCommission.toFixed(2)} generated for ${customer.companyName}'s payment.`,
    req
  });

  await PartnerNotification.create({
    partnerId: partner._id,
    type: "commission_created",
    title: "Commission earned",
    message: `${customer.companyName} paid for their subscription. You earned a commission of ₹${commission.calculation.netCommission.toLocaleString("en-IN", { maximumFractionDigits: 2 })}; it will be paid in a settlement once approved.`,
    entity: { type: "PartnerCommission", entityId: commission._id }
  });

  return { commission };
};

module.exports = { generateCommissionForWonOpportunity, generateCommissionForCustomerPayment };
