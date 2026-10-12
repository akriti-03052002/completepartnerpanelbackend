require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const Partner = require("../models/Partner");
const { generatePartnerCode } = require("../utils/generateCode");
const { demoPartnerQuery } = require("./demoAccounts");

async function run() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    const partners = await Partner.find(demoPartnerQuery);
    for (const partner of partners) {
      if (/^[1-9]\d{3}$/.test(partner.partnerCode)) continue;
      const oldCode = partner.partnerCode;
      const code = await generatePartnerCode();
      const changed = await Partner.updateOne({ _id: partner._id, partnerCode: oldCode }, { $set: { partnerCode: code } }, { runValidators: true });
      if (changed.modifiedCount !== 1) throw new Error("A demo code changed concurrently; check before retrying.");
      console.log(JSON.stringify({ type: partner.partnerType, previousCode: oldCode, partnerCode: code }));
    }
  } finally { await mongoose.disconnect(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
