const mongoose = require("mongoose");
const PDFDocument = require("pdfkit");
const { Invoice, Partner, Customer } = require("../models/Index");
const ResellerInvoice = require("../models/ResellerInvoice");

const downloadInvoice = (kind, audience) => async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Invoice not found." });
    const filter = { _id: req.params.id };
    if (audience === "partner") filter.partnerId = req.partner._id;
    if (audience === "customer") filter.customerId = req.customer._id;
    const invoice = await (kind === "reseller" ? ResellerInvoice : Invoice).findOne(filter).lean();
    if (!invoice) return res.status(404).json({ success: false, message: "Invoice not found." });
    const recipient = kind === "reseller" ? await Partner.findById(invoice.partnerId).lean() : await Customer.findById(invoice.customerId).lean();
    const number = invoice.invoiceNumber || `INV-${invoice._id}`;
    const pdf = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    const result = new Promise((resolve, reject) => { pdf.on("data", chunk => chunks.push(chunk)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject); });
    const date = value => value ? new Date(value).toLocaleDateString("en-IN") : "Not recorded";
    const money = value => `${invoice.currency || "INR"} ${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`;
    pdf.fontSize(22).text("SPOTX Invoice");
    pdf.moveDown().fontSize(11).text(`Invoice: ${number}`).text(`Issued: ${date(invoice.billDate || invoice.issuedAt || invoice.createdAt)}`).text(`Status: ${invoice.paymentStatus || invoice.status}`);
    pdf.moveDown().text(`Bill to: ${recipient?.legalEntity?.businessName || recipient?.companyName || recipient?.primaryContact?.name || "Account holder"}`);
    if (kind === "reseller") {
      pdf.moveDown().text("Screen licence purchase").text(`Order: ${invoice.orderCode || "Not recorded"}`).text(`Billing cycle: ${invoice.billingCycle}`).text(`Period: ${date(invoice.billingPeriodStart)} to ${date(invoice.billingPeriodEnd)}`).text(`Due: ${date(invoice.dueDate)}`).text(`Licences: ${invoice.purchasedLicenseSnapshot}`).text(`Unit price: ${money(invoice.unitPriceSnapshot)}`).text(`Cycle multiplier: ${invoice.cycleMultiplier}`);
      pdf.moveDown().text(`Subtotal: ${money(invoice.subtotal)}`).text(`Tax (${invoice.taxRatePercent}%): ${money(invoice.taxAmount)}`).font("Helvetica-Bold").text(`Total: ${money(invoice.total)}`);
    } else {
      pdf.moveDown().text("Subscription payment").font("Helvetica-Bold").text(`Recorded amount: ${money(invoice.amount)}`);
    }
    pdf.moveDown().font("Helvetica").fontSize(9).text("Generated from the saved invoice record. Payment status reflects the record at download time.");
    pdf.end();
    const buffer = await result;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "private, no-store");
    res.attachment(`${String(number).replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`);
    return res.send(buffer);
  } catch {
    return res.status(500).json({ success: false, message: "Could not generate the invoice. Please try again." });
  }
};
module.exports = { downloadInvoice };
