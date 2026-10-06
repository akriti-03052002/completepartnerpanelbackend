const ResellerPricingPlan = require("../models/ResellerPricingPlan");

/* ============================================================
   RESELLER PRICING
   Resolves the price a specific Reseller partner is charged,
   server-side only — a client-submitted price/quantity is never
   trusted for any purchase or invoice calculation.
============================================================ */

const getOrCreatePricingPlan = async (partnerId) => {
  let plan = await ResellerPricingPlan.findOne({ partnerId, isActive: true }).sort({ effectiveFrom: -1 });

  if (!plan) {
    // First-time default — discount_percent mode at 0% (i.e. standard
    // rate) until a superadmin sets the partner's actual negotiated
    // terms. Never silently charges a rate nobody agreed to.
    plan = await ResellerPricingPlan.create({
      partnerId,
      standardPricePerScreen: 100,
      pricingMode: "discount_percent",
      wholesaleDiscountPercent: 0,
      effectivePricePerScreen: 100,
      taxRatePercent: 18
    });
  }

  return plan;
};

// Resolves the per-screen rate for a given quantity, honoring bulkTiers
// (discount_percent mode only) per the plan's bulkTierBasis.
const resolveUnitPrice = async ({ plan, quantity, partnerId }) => {
  if (plan.pricingMode === "fixed_price") {
    return plan.fixedPricePerScreen || 0;
  }

  if (!plan.bulkTiers?.length) {
    return plan.effectivePricePerScreen;
  }

  let comparisonQty = quantity;

  if (plan.bulkTierBasis === "cumulative") {
    const ResellerInventory = require("../models/ResellerInventory");
    const inventory = await ResellerInventory.findOne({ partnerId });
    comparisonQty = (inventory?.totalPurchasedLicenses || 0) + quantity;
  }

  const applicableTier = [...plan.bulkTiers]
    .sort((a, b) => b.minQty - a.minQty)
    .find((tier) => comparisonQty >= tier.minQty);

  return applicableTier ? applicableTier.pricePerScreen : plan.effectivePricePerScreen;
};

// Server-computed pricing breakdown for a bulk purchase order.
const computeOrderPricing = async ({ partnerId, quantity }) => {
  const plan = await getOrCreatePricingPlan(partnerId);
  const unitPrice = await resolveUnitPrice({ plan, quantity, partnerId });

  const subtotal = unitPrice * quantity;
  const taxAmount = (subtotal * plan.taxRatePercent) / 100;
  const totalAmount = subtotal + taxAmount;

  return {
    plan,
    pricing: {
      standardUnitPrice: plan.standardPricePerScreen,
      pricingMode: plan.pricingMode,
      wholesaleDiscountPercent: plan.pricingMode === "discount_percent" ? plan.wholesaleDiscountPercent : undefined,
      fixedUnitPrice: plan.pricingMode === "fixed_price" ? plan.fixedPricePerScreen : undefined,
      unitPrice,
      subtotal,
      taxRatePercent: plan.taxRatePercent,
      taxAmount,
      discount: 0,
      totalAmount,
      currency: "INR"
    }
  };
};

module.exports = { getOrCreatePricingPlan, resolveUnitPrice, computeOrderPricing };
