/**
 * Seeds the real SPOTX Vendor tier structure + matching CommissionRules
 * (the tier's `benefits.commissionRate` is a display value only — the
 * commission engine reads the CommissionRule, so both must exist), plus
 * the one fully-specified cross-type fact we have: Affiliate's optional
 * 10%/6-month recurring add-on.
 *
 * Also seeds PLACEHOLDER ladders for Affiliate/Influencer/Referral/Reseller
 * (2026-08-24: no real numbers given yet for these — user asked to use
 * defaults for now and will supply real ones later). Each placeholder tier's
 * perks array is tagged "Placeholder — confirm real numbers with SPOTX" so
 * it's visibly not final in the admin UI. Numbers were chosen by scaling the
 * *shape* of Vendor's progression (roughly 1x / 1.7x / 2.5x / 4x across
 * tiers) onto each type's own metric — not derived from any real SPOTX data.
 * Re-run this script after replacing the placeholder blocks below with real
 * numbers; it only creates-if-missing so edit the numbers AND bump the
 * `code` (or delete the old docs) if you want a clean replace rather than
 * a stale duplicate sitting next to the new one.
 *
 * Idempotent: skips anything that already exists.
 * Run: node seed/seedTiers.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { PartnerTier, CommissionRule } = require("../models/Index");

const PLACEHOLDER_PERK = "Placeholder — confirm real numbers with SPOTX";

const VENDOR_TIERS = [
  { code: "REGISTERED", name: "Registered", level: 1, screenCount: { min: 0, max: 999 }, rate: 10, perks: ["Partner pricing", "Sales kit"] },
  { code: "CERTIFIED", name: "Certified", level: 2, screenCount: { min: 1000, max: 4999 }, rate: 15, perks: ["Training", "Demo account", "Lead sharing"] },
  { code: "GOLD", name: "Gold", level: 3, screenCount: { min: 5000, max: 14999 }, rate: 20, perks: ["Dedicated support", "Co-marketing"] },
  { code: "STRATEGIC", name: "Strategic", level: 4, screenCount: { min: 15000, max: null }, rate: 25, perks: ["White-label", "Territory rights", "Negotiable rate above 25%"] }
];

// Placeholder ladders — one-time/flat commission types (fixedAmount), so
// `rate` here means the flat payout, not a percentage.
const PLACEHOLDER_LADDERS = {
  affiliate: {
    metricLabel: "Leads referred",
    commissionType: "fixed_per_deal",
    calculationBase: "net_revenue",
    tiers: [
      { code: "AFFILIATE-REGISTERED", name: "Registered", level: 1, min: 0, max: 9, amount: 3000 },
      { code: "AFFILIATE-CERTIFIED", name: "Certified", level: 2, min: 10, max: 29, amount: 5000 },
      { code: "AFFILIATE-GOLD", name: "Gold", level: 3, min: 30, max: 74, amount: 8000 },
      { code: "AFFILIATE-STRATEGIC", name: "Strategic", level: 4, min: 75, max: null, amount: 12000 }
    ]
  },
  influencer: {
    metricLabel: "Campaign reach (followers)",
    commissionType: "fixed_per_deal",
    calculationBase: "net_revenue",
    tiers: [
      { code: "INFLUENCER-REGISTERED", name: "Registered", level: 1, min: 0, max: 49999, amount: 5000 },
      { code: "INFLUENCER-CERTIFIED", name: "Certified", level: 2, min: 50000, max: 199999, amount: 10000 },
      { code: "INFLUENCER-GOLD", name: "Gold", level: 3, min: 200000, max: 499999, amount: 20000 },
      { code: "INFLUENCER-STRATEGIC", name: "Strategic", level: 4, min: 500000, max: null, amount: 35000 }
    ]
  },
  referral: {
    metricLabel: "Introductions made",
    commissionType: "fixed_per_deal",
    calculationBase: "net_revenue",
    tiers: [
      { code: "REFERRAL-REGISTERED", name: "Registered", level: 1, min: 0, max: 4, amount: 2000 },
      { code: "REFERRAL-CERTIFIED", name: "Certified", level: 2, min: 5, max: 14, amount: 3500 },
      { code: "REFERRAL-GOLD", name: "Gold", level: 3, min: 15, max: 29, amount: 5000 },
      { code: "REFERRAL-STRATEGIC", name: "Strategic", level: 4, min: 30, max: null, amount: 7500 }
    ]
  }
  // Reseller intentionally has no tier ladder here — a Reseller partner
  // never earns a commission at all, so PartnerTier/CommissionRule don't
  // apply to it. Pricing instead lives on ResellerPricingPlan, set per
  // partner by superadmin (see backend/models/ResellerPricingPlan.js).
};

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  for (const t of VENDOR_TIERS) {
    let tier = await PartnerTier.findOne({ code: t.code, programId: { $exists: false } });

    if (!tier) {
      tier = await PartnerTier.create({
        partnerType: "vendor",
        name: t.name,
        code: t.code,
        level: t.level,
        qualification: {
          screenCount: t.screenCount,
          metric: { label: "Screens installed", min: t.screenCount.min, max: t.screenCount.max }
        },
        benefits: { commissionRate: t.rate, perks: t.perks },
        status: "active"
      });
      console.log(`Created tier: ${t.name}`);
    } else if (!tier.partnerType) {
      // Backfill for tiers created before partnerType existed on the schema.
      tier.partnerType = "vendor";
      tier.qualification.metric = { label: "Screens installed", min: t.screenCount.min, max: t.screenCount.max };
      await tier.save();
      console.log(`Backfilled partnerType on existing tier: ${t.name}`);
    } else {
      console.log(`Tier already exists, skipping: ${t.name}`);
    }

    const existingRule = await CommissionRule.findOne({ tierId: tier._id });

    if (!existingRule) {
      await CommissionRule.create({
        tierId: tier._id,
        partnerType: "vendor",
        name: `${t.name} — ${t.rate}% recurring`,
        commissionType: "recurring_percentage",
        rate: t.rate,
        calculationBase: "subscription_value",
        recurring: { enabled: true, durationType: "lifetime" },
        status: "active"
      });
      console.log(`  -> Created matching commission rule (${t.rate}% recurring)`);
    } else {
      console.log("  -> Commission rule already exists, skipping");
    }
  }

  // Placeholder ladders for the other 4 partner types.
  for (const [partnerType, ladder] of Object.entries(PLACEHOLDER_LADDERS)) {
    for (const t of ladder.tiers) {
      let tier = await PartnerTier.findOne({ code: t.code, programId: { $exists: false } });

      const isWholesale = ladder.commissionType === "wholesale_discount";

      if (!tier) {
        tier = await PartnerTier.create({
          partnerType,
          name: t.name,
          code: t.code,
          level: t.level,
          qualification: {
            metric: { label: ladder.metricLabel, min: t.min, max: t.max }
          },
          benefits: {
            commissionRate: t.amount,
            perks: [PLACEHOLDER_PERK]
          },
          status: "active"
        });
        console.log(`Created placeholder tier: ${partnerType} / ${t.name}`);
      } else {
        console.log(`Placeholder tier already exists, skipping: ${partnerType} / ${t.name}`);
      }

      const existingRule = await CommissionRule.findOne({ tierId: tier._id });

      if (!existingRule) {
        await CommissionRule.create({
          tierId: tier._id,
          partnerType,
          name: `${t.name} — ${isWholesale ? `${t.amount}% wholesale discount` : `Rs ${t.amount} per deal`} (placeholder)`,
          commissionType: ladder.commissionType,
          rate: isWholesale ? t.amount : 0,
          fixedAmount: isWholesale ? 0 : t.amount,
          calculationBase: ladder.calculationBase,
          status: "active"
        });
        console.log(`  -> Created matching placeholder commission rule`);
      } else {
        console.log("  -> Commission rule already exists, skipping");
      }
    }
  }

  // Affiliate's optional recurring add-on — the one fully-specified
  // cross-type fact given so far (10%, 6 months, admin-triggered per deal).
  const existingAddOn = await CommissionRule.findOne({ partnerType: "affiliate", isAddOn: true });

  if (!existingAddOn) {
    await CommissionRule.create({
      partnerType: "affiliate",
      isAddOn: true,
      name: "Affiliate — 10% recurring add-on (6 months)",
      commissionType: "recurring_percentage",
      rate: 10,
      calculationBase: "net_revenue",
      recurring: { enabled: true, durationType: "months", duration: 6 },
      status: "active"
    });
    console.log("Created Affiliate recurring add-on rule (10%, 6 months)");
  } else {
    console.log("Affiliate add-on rule already exists, skipping");
  }

  console.log("Done.");
  process.exit(0);
};

run().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
