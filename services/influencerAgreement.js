const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { SettlementSetting } = require("../models/Index");
const { getAgreementTemplate } = require("./agreementTemplate");
const agreementPaymentSchedule = require("./agreementPaymentSchedule");

const LOGO_PATH = path.join(__dirname, "..", "assets", "spotx-logo.png");
const LOGO_ASPECT = 789 / 307; // actual pixel dimensions of assets/spotx-logo.png

const BRAND_RED = "#EC2027";
const BRAND_BLACK = "#121212";
const CHARCOAL = "#2D2D2D";
const MUTED = "#666666";
const FAINT = "#999999";

const formatPercent = (n) => `${n}%`;
// The PDF's built-in Helvetica has no ₹ glyph (it prints as "¹"), so use "Rs.".
const formatMoney = (n) => `Rs. ${Number(n || 0).toLocaleString("en-IN")}`;

const PLATFORM_LABEL = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };

/**
 * The influencer's social accounts that have agreed rates — straight from the
 * per-post / per-reel rates an admin sets on each account (see
 * adminSocialMediaController.updateRates). These are the same amounts credited
 * automatically when content from that account is approved, so the agreement
 * is the one place prices are stated; nothing is priced per post later.
 */
const pricedAccounts = (partner) =>
  (partner.socialAccounts || []).filter((a) => a.reviewStatus !== "rejected" && (a.paymentRates?.post || a.paymentRates?.reel));

const formatAddress = (address) => {
  if (!address) return "[Address not on file]";
  const parts = [address.addressLine1, address.addressLine2, address.city, address.state, address.pincode, address.country].filter(Boolean);
  return parts.length ? parts.join(", ") : "[Address not on file]";
};

// Unknown {{names}} are left as typed so a typo is visible in the preview.
const fillPlaceholders = (text, values) =>
  String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => (values[key] !== undefined ? values[key] : match));

/**
 * Renders the Influencer Agreement from the admin-editable template (see
 * services/agreementTemplate.js) to an in-memory PDF. The influencer's
 * details and each account's rates are generated here, not taken from the
 * template text.
 */
const renderAgreementPdf = (partner, template, settlementSetting) => new Promise((resolve, reject) => {
  const effectiveDate = new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
  const agreementRef = `SPX-AGR-${partner.partnerCode}`;
  const accounts = pricedAccounts(partner);

  const settlementCycle = (settlementSetting?.settlementType || "monthly").toLowerCase();
  const taxNote = settlementSetting?.tax?.tdsEnabled
    ? `Tax will be deducted at source at ${formatPercent(settlementSetting.tax.tdsRate)} as applicable under Indian tax law.`
    : "Applicable taxes, including tax deducted at source, will be withheld as required under Indian law.";

  const values = {
    companyName: template.companyName || "SPOTX",
    registeredAddress: template.registeredAddress || "[Registered Office Address to be inserted]",
    influencerName: partner.primaryContact.name,
    influencerEmail: partner.primaryContact.email,
    influencerCode: partner.partnerCode,
    effectiveDate,
    settlementCycle,
    taxNote
  };
  const fill = (text) => fillPlaceholders(text, values);

  const doc = new PDFDocument({ size: "A4", margin: 56, bufferPages: true });
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));
  doc.on("end", () => resolve(Buffer.concat(chunks)));
  doc.on("error", reject);

  let sectionNumber = 0;
  const heading = (title) => {
    sectionNumber += 1;
    doc.moveDown(0.9);
    doc.fontSize(12).fillColor(BRAND_BLACK).font("Helvetica-Bold").text(`${sectionNumber}. ${title}`);
    doc.moveDown(0.3);
    doc.font("Helvetica");
  };
  const body = (text) => {
    if (!text) return;
    doc.fontSize(10).fillColor(CHARCOAL).text(text, { align: "justify", lineGap: 3 });
  };
  const bullet = (text) => {
    doc.fontSize(10).fillColor(CHARCOAL).text(`•  ${text}`, { align: "left", lineGap: 3, indent: 10 });
  };

  // ---- Letterhead ----
  // The source logo's "Spot" wordmark is white-on-transparent — invisible
  // on a white page unless backed by a dark badge, same fix Logo.jsx uses
  // on the web (a light background would swallow it otherwise).
  if (fs.existsSync(LOGO_PATH)) {
    const logoHeight = 28;
    const logoWidth = logoHeight * LOGO_ASPECT;
    const padding = 12;
    const badgeX = 56;
    const badgeY = doc.y;

    doc.roundedRect(badgeX, badgeY, logoWidth + padding * 2, logoHeight + padding * 2, 6).fill(BRAND_BLACK);
    doc.image(LOGO_PATH, badgeX + padding, badgeY + padding, { height: logoHeight, width: logoWidth });
    doc.y = badgeY + logoHeight + padding * 2 + 10;
  } else {
    doc.fontSize(22).fillColor(BRAND_RED).font("Helvetica-Bold").text("SPOT", { continued: true });
    doc.fillColor(BRAND_BLACK).text("X");
    doc.font("Helvetica");
    doc.moveDown(0.2);
  }
  doc.fontSize(16).fillColor(BRAND_BLACK).font("Helvetica-Bold").text(fill(template.title));
  doc.font("Helvetica");
  doc.moveDown(0.15);
  doc.fontSize(9).fillColor(MUTED).text(`Reference: ${agreementRef}    |    Effective Date: ${effectiveDate}`);
  doc.moveDown(0.6);
  doc.strokeColor("#E5E5E5").lineWidth(1).moveTo(56, doc.y).lineTo(539, doc.y).stroke();

  // ---- Opening paragraph ----
  doc.moveDown(0.8);
  body(fill(template.intro));

  // ---- Parties (always generated from the influencer's profile) ----
  heading("Parties");
  doc.fontSize(10).fillColor(BRAND_BLACK).font("Helvetica-Bold").text("The Influencer");
  doc.font("Helvetica").fillColor(CHARCOAL);
  doc.text(`Name: ${partner.primaryContact.name}`);
  if (partner.legalEntity?.legalName) doc.text(`Registered Legal Name: ${partner.legalEntity.legalName}`);
  doc.text(`Influencer Code: ${partner.partnerCode}`);
  doc.text(`Address: ${formatAddress(partner.address)}`);
  doc.text(`Email: ${partner.primaryContact.email}`);
  if (partner.primaryContact.phone) doc.text(`Phone: ${partner.primaryContact.phone}`);

  heading("Current payout settings");
  body(agreementPaymentSchedule(settlementSetting));

  // ---- Admin-written sections ----
  for (const section of template.sections) {
    heading(fill(section.heading));
    if (section.kind === "payment_rates") {
      if (accounts.length === 0) {
        body(fill(section.noRatesText || section.body));
      } else {
        body(fill(section.body));
        doc.moveDown(0.3);
        for (const a of accounts) {
          const rates = [];
          if (a.paymentRates.post) rates.push(`${formatMoney(a.paymentRates.post)} per post`);
          if (a.paymentRates.reel) rates.push(`${formatMoney(a.paymentRates.reel)} per reel`);
          bullet(`${PLATFORM_LABEL[a.platform] || a.platform} — ${a.username || a.accountId}: ${rates.join(", ")}`);
        }
      }
    } else {
      body(fill(section.body));
    }
    if (section.bullets?.length) {
      doc.moveDown(0.3);
      section.bullets.forEach((b) => bullet(fill(b)));
    }
    if (section.note) {
      doc.moveDown(0.4);
      body(fill(section.note));
    }
  }

  // ---- Closing note / signature block ----
  doc.moveDown(1.2);
  doc.strokeColor("#E5E5E5").lineWidth(1).moveTo(56, doc.y).lineTo(539, doc.y).stroke();
  doc.moveDown(0.6);
  if (template.footerNote) {
    doc.fontSize(9).fillColor(FAINT).text(fill(template.footerNote), { align: "justify", lineGap: 2 });
  }

  doc.moveDown(1.2);
  const colY = doc.y;
  doc.fontSize(9).fillColor(BRAND_BLACK).font("Helvetica-Bold").text(`For ${values.companyName}`, 56, colY);
  doc.font("Helvetica").fillColor(CHARCOAL).fontSize(9);
  doc.text("Authorized Signatory", 56, colY + 14);
  doc.text(`Issued on: ${effectiveDate}`, 56, colY + 28);

  doc.fontSize(9).fillColor(BRAND_BLACK).font("Helvetica-Bold").text("For the Influencer", 300, colY);
  doc.font("Helvetica").fillColor(CHARCOAL).fontSize(9);
  doc.text(partner.primaryContact.name, 300, colY + 14);

  // ---- Footer: page numbers on every page ----
  // Writing inside the bottom margin makes pdfkit think the content
  // overflows and silently appends a new blank page to fit it — zeroing
  // the margin for this one write avoids that.
  const pageRange = doc.bufferedPageRange();
  for (let i = 0; i < pageRange.count; i += 1) {
    doc.switchToPage(i);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.fontSize(8).fillColor(FAINT).text(
      `${agreementRef}  ·  Page ${i + 1} of ${pageRange.count}`,
      56,
      doc.page.height - 40,
      { width: doc.page.width - 112, align: "center" }
    );
    doc.page.margins.bottom = bottomMargin;
  }

  doc.end();
});

module.exports = { renderAgreementPdf };
