require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const { Partner, PartnerDocument, PartnerBankAccount } = require("../models/Index");
const { computeKycStatus, isProfileComplete } = require("../utils/partnerVerification");

async function run() {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    // Only explicitly named demo fixtures; do not match live users by name.
    const partners = await Partner.find({ $or: [
      { partnerCode: { $in: ["PTN-DEMO-VEN", "PTN-DEMO-RES", "PTN-DEMO001"] } },
      { "primaryContact.email": { $in: ["demo.reseller@spotx.in", "demo.document@example.com"] } }
    ] });
    for (const partner of partners) {
      const [documents, bank] = await Promise.all([
        PartnerDocument.find({ partnerId: partner._id }).lean(),
        PartnerBankAccount.findOne({ partnerId: partner._id }).select("verification.status").lean()
      ]);
      const kyc = computeKycStatus(documents, partner.partnerType);
      const verified = isProfileComplete(partner) && kyc === "verified" && bank?.verification?.status === "verified";
      const status = ["suspended", "inactive", "rejected"].includes(partner.status) ? partner.status : verified ? "active" : "pending_verification";
      await Partner.updateOne({ _id: partner._id, status: partner.status }, {
        $set: { status, "verification.overallStatus": verified ? "verified" : "pending" },
        ...(!verified ? { $unset: { "verification.verifiedAt": 1, "verification.verifiedBy": 1 } } : {})
      });
      console.log(JSON.stringify({ demoCode: partner.partnerCode, type: partner.partnerType, status, kyc, bank: bank?.verification?.status || "not_submitted" }));
    }
  } finally { await mongoose.disconnect(); }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
