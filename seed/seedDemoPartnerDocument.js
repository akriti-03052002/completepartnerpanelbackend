require("dotenv").config();
const mongoose = require("mongoose");
const PDFDocument = require("pdfkit");
const { Partner, PartnerDocument } = require("../models/Index");
const { storeBuffer, isCloudinaryConfigured } = require("../utils/fileStorage");
const { generatePartnerCode } = require("../utils/generateCode");

async function run() {
  if (!isCloudinaryConfigured()) throw new Error("Cloudinary credentials are required to upload the demo document.");
  await mongoose.connect(process.env.MONGO_URI);
  const email = "demo.document@example.com";
  let partner = await Partner.findOne({ "primaryContact.email": email });
  const partnerId = partner?._id || new mongoose.Types.ObjectId();
  let document = await PartnerDocument.findOne({ partnerId, documentType: "other" });
  if (!document) {
    const pdf = new PDFDocument();
    const chunks = [];
    const buffer = new Promise((resolve, reject) => {
      pdf.on("data", chunk => chunks.push(chunk));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);
    });
    pdf.fontSize(24).text("DEMO DOCUMENT - SAMPLE ONLY");
    pdf.moveDown().fontSize(12).text("Demo Affiliate Partner\nThis sample document is for testing uploads and previews.\nIt is not a KYC document or proof of identity.");
    pdf.end();
    const file = await storeBuffer(await buffer, {
      subfolder: String(partnerId), filename: `demo-sample-${Date.now()}.pdf`,
      originalName: "demo-sample.pdf", mimeType: "application/pdf"
    });
    if (!partner) partner = await Partner.create({
      _id: partnerId, partnerCode: generatePartnerCode(), partnerType: "affiliate",
      legalEntity: { businessName: "Demo Affiliate Partner", entityType: "individual" },
      primaryContact: { name: "Demo Partner", email },
      status: "pending_verification", verification: { overallStatus: "pending" }
    });
    document = await PartnerDocument.create({ partnerId, documentType: "other", file, verification: { status: "pending" } });
  }
  console.log(JSON.stringify({ name: partner.legalEntity.businessName, type: partner.partnerType, code: partner.partnerCode, partnerId: String(partnerId), document: document.file.originalName }));
}

run().catch(error => {
  console.error("Demo creation failed:", error.message);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
