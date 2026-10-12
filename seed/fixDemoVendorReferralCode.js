require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const Partner = require("../models/Partner");
const { generateNumericReferralCode } = require("../utils/generateCode");

async function run() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    // Only the legacy scenario/demo vendor; other partner records are untouched.
    const partner = await Partner.findOne({ partnerType: "vendor", "primaryContact.email": "vendor.scenario@spotx.demo" });
    if (!partner) throw new Error("Demo vendor not found.");
    if (/^[1-9]\d{3}$/.test(partner.referral?.referralCode || "")) {
      console.log(JSON.stringify({ name: partner.legalEntity?.businessName, referralCode: partner.referral.referralCode, changed: false }));
      return;
    }
    const previousCode = partner.referral?.referralCode;
    const configured = new URL(process.env.CLIENT_URL || "https://completepartnerpanelfrontend.vercel.app");
    const origin = ["localhost", "127.0.0.1"].includes(configured.hostname)
      ? "https://completepartnerpanelfrontend.vercel.app" : configured.origin;
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = generateNumericReferralCode();
      if (await Partner.exists({ "referral.referralCode": code })) continue;
      try {
        const updated = await Partner.findOneAndUpdate({ _id: partner._id, "referral.referralCode": previousCode }, {
          $set: { "referral.referralCode": code, "referral.referralLink": `${origin}/customer/register?ref=${code}` }
        }, { returnDocument: "after", runValidators: true });
        if (!updated) throw new Error("Referral code changed elsewhere. Retry after checking the vendor.");
        console.log(JSON.stringify({ name: updated.legalEntity?.businessName, previousCode, referralCode: updated.referral.referralCode, referralLink: updated.referral.referralLink, changed: true }));
        return;
      } catch (error) { if (error.code !== 11000) throw error; }
    }
    throw new Error("Could not reserve a unique four-digit referral code.");
  } finally { await mongoose.disconnect(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
