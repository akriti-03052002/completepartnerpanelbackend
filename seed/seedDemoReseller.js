/**
 * One-off script to create a demo Reseller partner with a known login
 * password, pre-populated with some inventory/pricing/customer data so
 * the panel isn't empty on first login. Bypasses the normal email-OTP
 * registration flow (this is a script, not the public API) but creates
 * the exact same Partner/PartnerUser shape registerPartner does, plus
 * marks the partner fully verified so every gated route (dashboard,
 * buy-licenses, allocations, billing) works immediately.
 *
 * Idempotent: re-running it just resets the demo account's password
 * and inventory rather than creating duplicates.
 *
 * Run: node seed/seedDemoReseller.js
 */
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const { Partner, PartnerUser } = require("../models/Index");
const ResellerInventory = require("../models/ResellerInventory");
const ResellerPricingPlan = require("../models/ResellerPricingPlan");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");
const ResellerCustomer = require("../models/ResellerCustomer");
const CustomerAllocation = require("../models/CustomerAllocation");
const { generatePartnerCode, generateReferralCode } = require("../utils/generateCode");
const { ROLE_PERMISSIONS } = require("../config/roles");

const DEMO_EMAIL = "demo.reseller@spotx.in";
const DEMO_PASSWORD = "Reseller@12345";

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);

  let partnerUser = await PartnerUser.findOne({ email: DEMO_EMAIL });
  let partner;

  if (partnerUser) {
    partner = await Partner.findById(partnerUser.partnerId);
    console.log("Demo reseller already exists — resetting password and inventory.");
  } else {
    const partnerCode = generatePartnerCode();

    let referralCode;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = generateReferralCode();
      // eslint-disable-next-line no-await-in-loop
      const taken = await Partner.exists({ "referral.referralCode": candidate });
      if (!taken) { referralCode = candidate; break; }
    }

    partner = await Partner.create({
      partnerCode,
      partnerType: "reseller",
      legalEntity: {
        businessName: "Demo Reseller Pvt Ltd",
        legalName: "Demo Reseller Private Limited",
        entityType: "private_limited",
        industry: "Digital Signage Reselling"
      },
      primaryContact: { name: "Demo Reseller", email: DEMO_EMAIL, phone: "+91 9876543210" },
      address: { country: "India", state: "Maharashtra", city: "Mumbai", addressLine1: "123 Demo Street", pincode: "400001" },
      referral: referralCode ? { referralCode, referralLink: `${process.env.CLIENT_URL || "http://localhost:5173"}/partner/register?ref=${referralCode}` } : undefined,
      verification: { overallStatus: "verified", verifiedAt: new Date() },
      // "active" is required by requireVerifiedPartner for every gated
      // route this demo needs to show off — real partners only reach
      // this after KYC + bank review, but this is a demo shortcut.
      status: "active"
    });

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);

    partnerUser = await PartnerUser.create({
      partnerId: partner._id,
      name: "Demo Reseller",
      email: DEMO_EMAIL,
      phone: "+91 9876543210",
      role: "owner",
      permissions: ROLE_PERMISSIONS.owner,
      auth: { provider: "email", passwordHash },
      status: "active"
    });

    console.log("Created demo reseller partner + owner user.");
  }

  // Always reset the password to the known demo value, even on a rerun.
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  await PartnerUser.updateOne({ _id: partnerUser._id }, { $set: { "auth.passwordHash": passwordHash, status: "active" } });
  await Partner.updateOne({ _id: partner._id }, { $set: { status: "active", "verification.overallStatus": "verified" } });

  // Pricing plan — 20% wholesale discount off the ₹100 standard rate.
  await ResellerPricingPlan.findOneAndUpdate(
    { partnerId: partner._id },
    {
      partnerId: partner._id,
      standardPricePerScreen: 100,
      pricingMode: "discount_percent",
      wholesaleDiscountPercent: 20,
      effectivePricePerScreen: 80,
      minPurchaseQty: 10,
      taxRatePercent: 18,
      isActive: true
    },
    { upsert: true }
  );

  // Billing config — monthly cycle, standard defaults.
  await ResellerBillingConfig.findOneAndUpdate(
    { partnerId: partner._id },
    { partnerId: partner._id, billingCycle: "monthly", dueDays: 7, gracePeriodDays: 3 },
    { upsert: true }
  );

  // Seed some inventory so the dashboard isn't empty: 600 purchased,
  // one demo customer with 100 allocated/80 registered/80 active.
  await ResellerInventory.findOneAndUpdate(
    { partnerId: partner._id },
    {
      partnerId: partner._id,
      totalPurchasedLicenses: 600,
      totalAllocatedLicenses: 100,
      totalRegisteredScreens: 80,
      totalActiveScreens: 80,
      totalSuspendedScreens: 0,
      status: "active"
    },
    { upsert: true }
  );

  let demoCustomer = await ResellerCustomer.findOne({ partnerId: partner._id, "businessDetails.companyName": "Demo Customer A" });
  if (!demoCustomer) {
    demoCustomer = await ResellerCustomer.create({
      partnerId: partner._id,
      businessDetails: { companyName: "Demo Customer A", gstin: "" },
      contactDetails: { name: "Customer Contact", email: "customer.a@example.com", phone: "+91 9123456780" },
      status: "active"
    });
  }

  await CustomerAllocation.findOneAndUpdate(
    { partnerId: partner._id, customerId: demoCustomer._id },
    {
      partnerId: partner._id,
      customerId: demoCustomer._id,
      allocatedLicenses: 100,
      registeredScreens: 80,
      activeScreens: 80,
      suspendedScreens: 0,
      status: "active",
      allocatedAt: new Date(),
      activatedAt: new Date()
    },
    { upsert: true }
  );

  console.log("\n===================================");
  console.log("DEMO RESELLER LOGIN");
  console.log("===================================");
  console.log("URL:      http://localhost:5173/partner/login");
  console.log("Email:    " + DEMO_EMAIL);
  console.log("Password: " + DEMO_PASSWORD);
  console.log("===================================\n");

  process.exit(0);
};

run().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
