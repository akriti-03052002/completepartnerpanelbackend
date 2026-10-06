/**
 * Shared enum constants used across the Partner Panel schemas.
 * Moved out of models/index.js so they live in one place.
 */

const PARTNER_TYPES = [
  "vendor",
  "influencer",
  "affiliate",
  "reseller"
];

const PARTNER_STATUS = [
  "draft",
  "pending_verification",
  "under_review",
  "active",
  "suspended",
  "rejected",
  "inactive"
];

const VERIFICATION_STATUS = [
  "not_submitted",
  "pending",
  "verified",
  "rejected",
  "expired"
];

const COMMISSION_TYPES = [
  "percentage",
  "fixed_per_deal",
  "fixed_per_screen",
  "recurring_percentage",
  "recurring_fixed",
  "hybrid"
  // "wholesale_discount" removed — Reseller partners no longer earn a
  // commission at all. They purchase licenses from SPOTX and are billed
  // for it instead; see backend/models/ResellerPricingPlan.js and
  // backend/models/ResellerInvoice.js.
];

// Reseller-only: which side of the license-purchase-vs-pricing rate a
// Reseller partner is on, set per partner by superadmin from their signed
// agreement — see backend/models/ResellerPricingPlan.js.
const RESELLER_PRICING_MODES = ["discount_percent", "fixed_price"];

// Reseller-only: how often SPOTX bills a Reseller partner for their total
// purchased licenses (never based on usage) — set per partner's agreement.
const RESELLER_BILLING_CYCLES = ["monthly", "quarterly", "yearly"];
// A licence purchase is priced as a 12-month term, billed in instalments
// on the reseller's billing cycle (see services/resellerBilling.js).
const RESELLER_LICENSE_TERM_MONTHS = 12;

const SETTLEMENT_TYPES = [
  "monthly",
  "quarterly",
  "threshold",
  "manual"
];

// How long a customer's prepaid subscription term runs, in months — chosen
// at subscribe/renew time (see customerSubscriptionController.js). Price
// scales with this: screenCount × plan rate per screen × durationMonths.
const SUBSCRIPTION_DURATIONS = [1, 3, 6, 12];

// GST charged on top of the base subscription amount, applied in
// customerSubscriptionController before creating a Razorpay order. 18% is
// the standard India GST slab for SaaS/software services. Kept as a plain
// constant (not stored on ScreenPricing) so this pass doesn't touch any
// existing model.
const GST_RATE_PERCENT = 18;

// Why a settlement is on_hold. Objective codes (bank_unverified,
// bank_change_pending, partner_suspended) can only be released once the
// underlying condition is actually resolved — see utils/settlementHold.js.
// compliance_review/incomplete_info/manual are judgment calls, released
// at an admin's discretion.
const SETTLEMENT_HOLD_CODES = [
  "bank_unverified",
  "bank_change_pending",
  "partner_suspended",
  "compliance_review",
  "incomplete_info",
  "manual"
];

module.exports = {
  PARTNER_TYPES,
  PARTNER_STATUS,
  VERIFICATION_STATUS,
  COMMISSION_TYPES,
  RESELLER_PRICING_MODES,
  RESELLER_BILLING_CYCLES,
  RESELLER_LICENSE_TERM_MONTHS,
  SETTLEMENT_TYPES,
  SETTLEMENT_HOLD_CODES,
  SUBSCRIPTION_DURATIONS,
  GST_RATE_PERCENT
};