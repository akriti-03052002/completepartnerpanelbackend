require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const { Partner } = require("../models/Index");
const { isCloudinaryConfigured } = require("../utils/fileStorage");
const verifyDemoPartner = require("./demoVerification");

async function run() {
  if (!isCloudinaryConfigured()) throw new Error("Cloudinary is required for downloadable demo KYC files.");
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    const partners = await Partner.find({ $or: [
      { partnerCode: { $in: ["PTN-DEMO-VEN", "PTN-DEMO-RES", "PTN-DEMO001"] } },
      { "primaryContact.email": { $in: ["demo.reseller@spotx.in", "demo.document@example.com"] } }
    ] });
    for (const partner of partners) {
      await verifyDemoPartner(partner);
      const updated = await Partner.findById(partner._id);
      console.log(JSON.stringify({ demoCode: updated.partnerCode, type: updated.partnerType, status: updated.status, verification: updated.verification.overallStatus }));
    }
  } finally { await mongoose.disconnect(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
