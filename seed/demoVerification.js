const PDFDocument = require("pdfkit");
const { PartnerDocument, PartnerBankAccount } = require("../models/Index");
const { getRequiredDocumentTypes, latestDocumentsByType } = require("../utils/partnerVerification");
const { storeBuffer } = require("../utils/fileStorage");
const { encrypt } = require("../utils/encryption");
const { autoActivatePartnerIfVerified } = require("../services/vendorActivation");

async function verifyDemoPartner(partner) {
  const allowed = ["PTN-DEMO-VEN", "PTN-DEMO-RES", "PTN-DEMO001"].includes(partner.partnerCode)
    || ["demo.reseller@spotx.in", "demo.document@example.com"].includes(partner.primaryContact?.email);
  if (!allowed) throw new Error("Verification fixtures are restricted to named demo accounts.");
  partner.primaryContact.phone ||= "+91 9876543210";
  partner.address ||= {};
  for (const [key, value] of Object.entries({ country: "India", state: "Maharashtra", city: "Mumbai", addressLine1: "Demo address — sample only", pincode: "400001" })) partner.address[key] ||= value;
  await partner.save();
  const latest = latestDocumentsByType(await PartnerDocument.find({ partnerId: partner._id }).lean());
  let cheque;
  for (const type of getRequiredDocumentTypes(partner.partnerType)) {
    let document = latest.get(type);
    if (document?.verification?.status !== "verified") {
      const pdf = new PDFDocument();
      const chunks = [];
      const buffer = new Promise((resolve, reject) => { pdf.on("data", chunk => chunks.push(chunk)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject); });
      pdf.fontSize(24).text("DEMO SAMPLE — TESTING ONLY");
      pdf.moveDown().fontSize(12).text(`${partner.legalEntity.businessName}\n${type.replaceAll("_", " ")}\nThis is fictional demo data. It is not proof of identity, registration or bank ownership.`);
      pdf.end();
      const file = await storeBuffer(await buffer, { subfolder: String(partner._id), filename: `demo-${type}-${Date.now()}.pdf`, originalName: `DEMO-${type}.pdf`, mimeType: "application/pdf" });
      document = await PartnerDocument.create({ partnerId: partner._id, documentType: type, documentDescription: "Demo sample for testing only", file, verification: { status: "verified", verifiedAt: new Date() } });
    }
    if (type === "cancelled_cheque") cheque = document;
  }
  let bank = await PartnerBankAccount.findOne({ partnerId: partner._id });
  if (!bank) bank = new PartnerBankAccount({ partnerId: partner._id, accountHolderName: partner.primaryContact.name, bankName: "Demo Bank — not a real account", accountNumberEncrypted: encrypt("000000000000"), accountNumberLast4: "0000", ifscEncrypted: encrypt("DEMO0000000"), ifscMasked: "DEMO***0000", accountType: "savings" });
  bank.cancelledChequeDocumentId = cheque._id;
  bank.verification.status = "verified";
  bank.verification.verifiedAt = new Date();
  bank.verification.rejectionReason = "";
  bank.verification.overrideReason = "Demo fixture approved for testing only; no real bank verification performed.";
  await bank.save();
  await autoActivatePartnerIfVerified(partner._id);
}
module.exports = verifyDemoPartner;
