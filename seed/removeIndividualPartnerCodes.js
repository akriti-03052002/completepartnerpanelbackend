require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const Partner = require("../models/Partner");

async function run() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    const result = await Partner.updateMany({ partnerType: { $in: ["affiliate", "influencer"] } }, {
      $unset: { "referral.referralCode": "", "referral.referralLink": "" }
    });
    console.log(JSON.stringify({ checked: result.matchedCount, updated: result.modifiedCount, scope: "affiliate and influencer codes only" }));
  } finally { await mongoose.disconnect(); }
}
run().catch(error => { console.error(error.name); process.exitCode = 1; });
