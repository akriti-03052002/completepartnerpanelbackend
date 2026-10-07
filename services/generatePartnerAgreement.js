const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { SettlementSetting, PartnerDocument } = require("../models/Index");
const PartnerAgreementAcceptance = require("../models/PartnerAgreementAcceptance");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");
const ResellerPricingPlan = require("../models/ResellerPricingPlan");
const { findApplicableCommissionRule } = require("../utils/partnerCommissionResolver");
const { getAgreementTemplate } = require("./agreementTemplate");
const { renderAgreementPdf: renderInfluencerAgreementPdf } = require("./influencerAgreement");

const { storeBuffer } = require("../utils/fileStorage");
const LOGO_PATH = path.join(__dirname, "..", "assets", "spotx-logo.png");
const LOGO_ASPECT = 789 / 307; // actual pixel dimensions of assets/spotx-logo.png

const BRAND_RED = "#EC2027";
const BRAND_BLACK = "#121212";
const CHARCOAL = "#2D2D2D";
const MUTED = "#666666";
const FAINT = "#999999";

/**
 * Same rule-lookup precedence the commission engine itself uses (tier's
 * rule, falling back to a generic tier-less one) — the agreement should
 * describe the exact terms that will actually apply, not a paraphrase.
 */
const findApplicableRule = findApplicableCommissionRule;

const formatPercent = (n) => `${n}%`;
const formatMoney = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

const CALCULATION_BASE_LABEL = {
  invoice_total: "the total invoice value of the deal",
  subscription_value: "the customer's subscription value",
  net_revenue: "the net revenue recognized on the deal",
  first_payment: "the customer's first payment only",
  screen_count: "the number of screens on the deal"
};

/**
 * Turns a CommissionRule document into a plain-English sentence describing
 * exactly how and when the partner gets paid — this is the one part of the
 * agreement that must never drift from what the commission engine actually
 * computes (see services/commissionEngine.js).
 */
const describeCommissionRule = (rule) => {
  if (!rule) {
    return "No commission rule is currently configured for this partner. SPOTX will assign one before any commission becomes payable, and this Agreement will be reissued to reflect it.";
  }

  const base = CALCULATION_BASE_LABEL[rule.calculationBase] || "the applicable deal value";
  const recurringNote = rule.recurring?.enabled
    ? rule.recurring.durationType === "lifetime"
      ? " for as long as the underlying subscription remains active"
      : rule.recurring.duration
        ? ` for ${rule.recurring.duration} ${rule.recurring.durationType}`
        : ""
    : "";

  switch (rule.commissionType) {
    case "wholesale_discount":
      return `The Partner purchases SPOTX's platform at a wholesale discount of ${formatPercent(rule.rate)} off ${base}. This discount is the Partner's full margin on resale and is realized at the time of purchase — it is not a recurring payout and does not flow through SPOTX's standard settlement cycle.`;

    case "percentage":
      return `The Partner earns a commission of ${formatPercent(rule.rate)} of ${base}, one time for each customer the Partner brings in, on that customer's first subscription payment. No further commission is earned from that customer afterwards, whether on renewals or on screens added later.`;

    case "recurring_percentage":
      return `The Partner earns a recurring commission of ${formatPercent(rule.rate)} of ${base} on every subscription payment made by each customer the Partner brings in${recurringNote}.`;

    case "fixed_per_deal":
      return `The Partner earns a fixed commission of ${formatMoney(rule.fixedAmount)} per customer, one time for each customer the Partner brings in, on that customer's first subscription payment.`;

    case "recurring_fixed":
      return `The Partner earns a fixed recurring commission of ${formatMoney(rule.fixedAmount)} on every subscription payment made by each customer the Partner brings in${recurringNote}.`;

    case "fixed_per_screen":
      return `The Partner earns a fixed commission of ${formatMoney(rule.perScreenAmount)} per screen, one time for each customer the Partner brings in, on that customer's first subscription payment. No further commission is earned from that customer afterwards, whether on renewals or on screens added later.`;

    case "hybrid": {
      const parts = [];
      if (rule.hybrid?.percentageRate) parts.push(`${formatPercent(rule.hybrid.percentageRate)} of ${base}`);
      if (rule.hybrid?.fixedAmount) parts.push(`a fixed ${formatMoney(rule.hybrid.fixedAmount)} per deal`);
      if (rule.hybrid?.perScreenAmount) parts.push(`${formatMoney(rule.hybrid.perScreenAmount)} per screen`);
      return `The Partner earns a combined commission of ${parts.join(" plus ")} one time for each customer the Partner brings in, on that customer's first subscription payment. No further commission is earned from that customer afterwards, whether on renewals or on screens added later.`;
    }

    default:
      return "Commission terms for this rule type will be confirmed separately by SPOTX.";
  }
};

const SCOPE_BY_PARTNER_TYPE = {
  vendor: "The Partner will refer and onboard end-customers who subscribe to the SPOTX platform, either by registering customers directly on the Partner's behalf or by sharing the Partner's unique customer referral code. Each registered customer receives a 30-day free trial before conversion to a paid subscription.",
  affiliate: "The Partner will refer qualified leads for prospective customers to SPOTX in exchange for the Referral Reward described in Section 5 below.",
  influencer: "The Partner will promote SPOTX to its audience and refer prospective customers and leads to SPOTX in exchange for the commission described in Section 5 below.",
  referral: "The Partner will make bona fide introductions of prospective customers to SPOTX in exchange for a referral fee as described in Section 5 below.",
  agency: "The Partner will represent and refer SPOTX's platform to its own client base under the arrangement configured in the SPOTX Partner Panel.",
  reseller: "The Partner will purchase SPOTX screen software licenses in bulk, at the pricing (a discount off SPOTX's standard rate, or a flat negotiated rate) set out in this agreement. Each purchase is billed separately on the agreed billing cycle, starting from its own purchase date, regardless of usage. The Partner will resell those licenses bundled with its own screen hardware to its own end-customers, under its own commercial terms; SPOTX has no involvement in, or visibility into, that resale transaction.",
  technology: "The Partner will integrate, bundle, or otherwise technically collaborate with SPOTX's platform under the arrangement configured in the SPOTX Partner Panel.",
  strategic: "The Partner will collaborate with SPOTX under a strategic partnership arrangement as configured in the SPOTX Partner Panel."
};

// EACH PARTNER TYPE HAS ITS OWN AGREEMENT. The wording below is specific
// to each type and must stay distinct:
//   - Vendor:     earns commission per the commission rule / custom
//                 assignment actually configured for them.
//   - Affiliate:  earns a one-time Referral Reward that SPOTX sets per won
//                 deal (see adminLeadController.markWon) — no commission rule.
//   - Reseller:   buys licenses and is invoiced — earns no commission.
//   - Influencer: not covered here at all; their agreement is the shared
//                 editable template in services/influencerAgreement.js.
// Every body section is additionally editable per partner (see
// Partner.agreementTerms in models/Partner.js) — `defaultText` is what
// renders when the partner has no override for that section. Sections
// render in this order with automatic numbering.
const isReseller = (partner) => partner.partnerType === "reseller";
const isAffiliate = (partner) => partner.partnerType === "affiliate";

// THE FORM OF THE DOCUMENT ITSELF differs per type, not just one clause:
// its name, what the other party is called, the opening paragraph, and a
// "How payment works" box stating which way money moves. (An Influencer's
// form is the separate template in services/influencerAgreement.js.)
const AGREEMENT_FORMS = {
  affiliate: {
    title: "Affiliate Referral Agreement",
    party: "Affiliate",
    fileSlug: "affiliate-referral-agreement",
    purpose: "sets out how the Affiliate refers leads to SPOTX and is paid a one-time Referral Reward for each referred lead that SPOTX closes as a won deal",
    paymentSummary: [
      ["Who pays whom", "SPOTX pays the Affiliate"],
      ["Paid for", "Each referred lead that SPOTX closes as a won deal"],
      ["Amount", "A one-time Referral Reward set by SPOTX for that deal when it is won"],
      ["Not paid for", "Leads that are rejected, and deals that are lost"]
    ]
  },
  vendor: {
    title: "Vendor Commission Agreement",
    party: "Vendor",
    fileSlug: "vendor-commission-agreement",
    purpose: "sets out how the Vendor brings customers to the SPOTX platform and earns commission on what those customers pay",
    paymentSummary: [
      ["Who pays whom", "SPOTX pays the Vendor"],
      ["Paid for", "Payments made to SPOTX by customers the Vendor brought in"],
      ["Amount", "Commission at the rate set out in the Commission & Payment Terms section"],
      ["Not paid for", "Free trials, and payments that are cancelled or refunded"]
    ]
  },
  reseller: {
    title: "Reseller Licence Purchase Agreement",
    party: "Reseller",
    fileSlug: "reseller-licence-purchase-agreement",
    purpose: "sets out how the Reseller buys SPOTX screen software licences from SPOTX, pays SPOTX's invoices for them, and resells them to its own customers",
    paymentSummary: [
      ["Who pays whom", "The Reseller pays SPOTX"],
      ["Paid for", "The licences the Reseller has purchased, whether or not they are in use"],
      ["Amount", "As invoiced by SPOTX at the pricing set out in the Purchase & Payment Terms section"],
      ["Commission", "None. SPOTX pays the Reseller no commission, reward or settlement"]
    ]
  }
};

const DEFAULT_AGREEMENT_FORM = {
  title: "Partner Agreement",
  party: "Partner",
  fileSlug: "partner-agreement",
  purpose: "sets out the terms on which the Partner takes part in the SPOTX Partner Program",
  paymentSummary: []
};

const agreementFormFor = (partnerType) => AGREEMENT_FORMS[partnerType] || DEFAULT_AGREEMENT_FORM;

// Affiliate rewards are not formula-based: SPOTX sets the amount for each
// deal when it closes, so the agreement says exactly that.
const AFFILIATE_REWARD_TERMS =
  "For each lead referred by the Partner that SPOTX closes as a won deal, SPOTX will determine a one-time Referral Reward " +
  "payable on that deal at the time the deal is closed. The amount is recorded against the lead in the SPOTX " +
  "Partner Panel and notified to the Partner. No Referral Reward is payable on leads that are rejected or deals that are lost.";

// What each type calls the money it earns, in the clauses that are
// otherwise worded the same.
const earningsNoun = (partner) => (isAffiliate(partner) ? "Referral Reward" : "commission");

const AGREEMENT_SECTIONS = [
  {
    key: "background",
    title: () => "Background",
    defaultText: () =>
      "SPOTX operates an enterprise-grade digital signage platform that enables businesses to manage content, monitor " +
      "screens, schedule campaigns, and track performance across their screen network from a single dashboard. The " +
      "Partner wishes to participate in the SPOTX Partner Program in the capacity described below, and SPOTX is " +
      "willing to grant such participation on the terms of this Agreement."
  },
  {
    key: "scope",
    title: () => "Scope of Partnership",
    defaultText: (partner) => SCOPE_BY_PARTNER_TYPE[partner.partnerType] ||
      "The scope of this partnership is as configured for the Partner in the SPOTX Partner Panel."
  },
  {
    key: "onboarding",
    title: () => "Onboarding & Verification",
    defaultText: () =>
      "This Agreement, and the Partner's ability to use the referral, sales, and payout features of the SPOTX Partner " +
      "Panel, is conditioned on SPOTX's verification of the Partner's KYC documents and bank account details. The " +
      "Partner represents and warrants that all information and documents submitted for this purpose are true, " +
      "accurate, and not misleading. SPOTX reserves the right to suspend or reject the Partner's account if this is " +
      "found not to be the case."
  },
  {
    key: "payment",
    title: (partner) => {
      if (isReseller(partner)) return "Purchase & Payment Terms";
      if (isAffiliate(partner)) return "Referral Reward & Payment Terms";
      return "Commission & Payment Terms";
    },
    defaultText: (partner, { rule, settlementCadence, tdsNote }) => {
      if (isReseller(partner)) {
        return "The Partner purchases SPOTX screen software licenses in bulk, at the per-screen, per-month price set out in the " +
          "Partner's Reseller Pricing Plan (configured for the Partner in the SPOTX Partner Panel). Each purchase is a " +
          "separate bill for a 12-month term: the price per month is the number of licenses purchased multiplied by the " +
          "per-screen price, and the 12-month total is twelve times that, plus applicable tax. That total is paid in " +
          "instalments on the Partner's billing cycle, each instalment invoiced in advance on the first day of the cycle " +
          "it covers, the first on the day of purchase. A later purchase of further licenses is a new bill, at the price " +
          "in force on that day, with its own billing cycle starting on its own purchase date.\n\n" +
          "Licenses are billed whether or not they are in use, and billing continues cycle after cycle for as long as " +
          "the licenses are held. Payment of each invoice is due per the terms stated on that invoice. SPOTX reserves " +
          "the right to suspend the Partner's license allocation for non-payment of an overdue invoice.";
      }
      if (isAffiliate(partner)) {
        return `${AFFILIATE_REWARD_TERMS}\n\n` +
          `A Referral Reward is recorded by SPOTX at the time a deal is won, and becomes eligible for settlement ` +
          `after SPOTX's internal review and approval. Settlements are processed on a ${settlementCadence.toLowerCase()} basis to the ` +
          `bank account verified by the Partner in the SPOTX Partner Panel.${tdsNote} SPOTX reserves the right to hold or ` +
          `reverse any Referral Reward connected to a deal that is subsequently cancelled, refunded, or found to be fraudulent.`;
      }
      return `${describeCommissionRule(rule)}\n\n` +
        `Commission is calculated and recorded by SPOTX when the customer pays, on the amount paid before tax, and becomes eligible for settlement ` +
        `after SPOTX's internal review and approval. Settlements are processed on a ${settlementCadence.toLowerCase()} basis to the ` +
        `bank account verified by the Partner in the SPOTX Partner Panel.${tdsNote} SPOTX reserves the right to hold or ` +
        `reverse any commission connected to a deal that is subsequently cancelled, refunded, or found to be fraudulent.`;
    }
  },
  {
    key: "termTermination",
    title: () => "Term & Termination",
    defaultText: (partner) =>
      "This Agreement commences on the Effective Date and continues until terminated by either Party. Either Party " +
      "may terminate this Agreement for convenience upon thirty (30) days' prior written notice to the other Party. " +
      "SPOTX may suspend or terminate this Agreement immediately upon written notice if the Partner breaches this " +
      "Agreement, provides false information, or engages in fraudulent or unlawful conduct. " +
      (isReseller(partner)
        ? "Termination does not relieve the Partner of any invoiced amount already due under this Agreement."
        : `Termination does not affect ${isAffiliate(partner) ? "Referral Rewards" : "commission"} already earned on deals won prior to the effective date of ` +
          "termination, which remains payable per the settlement terms above.")
  },
  {
    key: "confidentiality",
    title: () => "Confidentiality",
    defaultText: () =>
      "Each Party agrees to keep confidential all non-public business, technical, financial, and customer information " +
      "disclosed by the other Party in connection with this Agreement, and to use such information solely to perform " +
      "its obligations under this Agreement. This obligation survives termination of this Agreement."
  },
  {
    key: "intellectualProperty",
    title: () => "Intellectual Property",
    defaultText: () =>
      "SPOTX retains all right, title, and interest in and to its platform, software, trademarks, and brand assets. " +
      "The Partner is granted a limited, non-exclusive, non-transferable right to use SPOTX's name and marks solely " +
      "for marketing SPOTX to prospective customers under this Agreement, in accordance with SPOTX's brand " +
      "guidelines, and such right terminates automatically upon termination of this Agreement."
  },
  {
    key: "dataProtection",
    title: () => "Data Protection & Compliance",
    defaultText: () =>
      "Each Party will comply with applicable law in performing its obligations under this Agreement, including " +
      "applicable data protection law when handling personal information of prospective or registered customers. " +
      "The Partner will not misrepresent SPOTX's products, pricing, or terms to any prospective customer."
  },
  {
    key: "liability",
    title: () => "Limitation of Liability",
    defaultText: (partner) =>
      "Neither Party will be liable to the other for any indirect, incidental, or consequential damages arising out " +
      "of this Agreement. Each Party's total liability under this Agreement is limited to the " +
      (isReseller(partner)
        ? "amounts actually paid or payable by the Partner to SPOTX"
        : `${earningsNoun(partner)} amounts actually paid or payable to the Partner`) +
      " in the twelve (12) months preceding the event giving rise to the claim."
  },
  {
    key: "governingLaw",
    title: () => "Governing Law & Dispute Resolution",
    defaultText: () =>
      "This Agreement is governed by the laws of India. The Parties will first attempt to resolve any dispute arising " +
      "out of this Agreement through good-faith discussion, failing which the dispute will be subject to the " +
      "exclusive jurisdiction of the competent courts in India."
  },
  {
    key: "notices",
    title: () => "Notices",
    defaultText: (partner) =>
      `Notices under this Agreement will be sent to the Partner at ${partner.primaryContact.email} and will be deemed ` +
      "delivered when sent. SPOTX may also notify the Partner in-app via the SPOTX Partner Panel."
  },
  {
    key: "entireAgreement",
    title: () => "Entire Agreement",
    defaultText: (partner) =>
      "This Agreement, generated by the SPOTX Partner Panel upon verification of the Partner's account, reflects the " +
      "commercial terms configured for the Partner as of the Effective Date and constitutes the entire understanding " +
      "between the Parties regarding the subject matter herein. Any amendment to the " +
      (isReseller(partner)
        ? "pricing or scope"
        : isAffiliate(partner) ? "Referral Reward terms or scope" : "commission structure or scope") +
      " described above will be reflected in a reissued version of this Agreement."
  }
];

/**
 * Everything the section defaults need beyond the partner itself — the
 * live tier, commission rule and settlement terms (or, for a Reseller, the
 * live pricing plan and billing config). Loaded fresh on every generation
 * so the agreement always describes what's actually configured right now.
 */
const loadAgreementContext = async (partner) => {
  const [rule, settlementSetting, pricingPlan, billingConfig] = await Promise.all([
    // Only a Vendor's earnings come from a commission rule.
    partner.partnerType === "vendor" ? findApplicableRule(partner) : null,
    SettlementSetting.findOne({ partnerId: partner._id }),
    isReseller(partner) ? ResellerPricingPlan.findOne({ partnerId: partner._id }) : null,
    isReseller(partner) ? ResellerBillingConfig.findOne({ partnerId: partner._id }) : null
  ]);

  const settlementCadence = settlementSetting
    ? settlementSetting.settlementType.charAt(0).toUpperCase() + settlementSetting.settlementType.slice(1)
    : "Monthly";
  const tdsNote = settlementSetting?.tax?.tdsEnabled
    ? ` Tax will be deducted at source at ${formatPercent(settlementSetting.tax.tdsRate)} as applicable under Indian tax law.`
    : " Applicable taxes, including tax deducted at source, will be withheld as required under Indian law.";

  return { rule, settlementCadence, tdsNote: `${tdsNote} ${require("./agreementPaymentSchedule")(settlementSetting)}`, pricingPlan, billingConfig };
};

// Effective text for a section: the partner's saved override if they have
// one, otherwise the standard default for their partner type.
const resolveSectionText = (partner, section, context) => {
  const override = partner.agreementTerms?.[section.key];
  return typeof override === "string" && override.trim() ? override : section.defaultText(partner, context);
};

// Builds the [label, value] rows for the Reseller "current pricing & billing
// terms" table from the partner's live ResellerPricingPlan /
// ResellerBillingConfig — the actual numbers currently in effect, not prose
// describing where to find them. Either doc may be absent (the config was
// never created) — rows are simply omitted in that case.
const buildPricingTermsRows = (plan, config) => {
  const rows = [];

  if (plan) {
    rows.push(["Pricing Mode", plan.pricingMode === "fixed_price" ? "Fixed Price" : "Discount off Standard Price"]);
    rows.push(["Standard List Price per Screen", `Rs. ${plan.standardPricePerScreen}`]);
    if (plan.pricingMode === "fixed_price") {
      rows.push(["Fixed Price per Screen", `Rs. ${plan.fixedPricePerScreen || 0}`]);
    } else {
      rows.push(["Wholesale Discount", `${plan.wholesaleDiscountPercent || 0}%`]);
    }
    if (plan.effectivePricePerScreen !== undefined) rows.push(["Effective Price per Screen", `Rs. ${plan.effectivePricePerScreen}`]);
    if (plan.minPurchaseQty !== undefined) rows.push(["Minimum Purchase Quantity", `${plan.minPurchaseQty} screen(s) per order`]);
    if (plan.taxRatePercent !== undefined) rows.push(["Applicable Tax Rate", `${plan.taxRatePercent}%`]);
    if (plan.pricingMode === "discount_percent" && Array.isArray(plan.bulkTiers) && plan.bulkTiers.length) {
      rows.push([
        "Bulk Pricing Tiers",
        plan.bulkTiers.map((t) => `${t.minQty}+ units @ Rs. ${t.pricePerScreen}/screen`).join("; ")
      ]);
      rows.push(["Bulk Tier Basis", plan.bulkTierBasis === "cumulative" ? "Cumulative purchased-to-date" : "Per order"]);
    }
  }

  if (config) {
    rows.push(["Billing Metric", "Total purchased licenses (regardless of usage)"]);
    rows.push(["Billing Cycle", (config.billingCycle || "monthly").replace(/^./, (c) => c.toUpperCase())]);
    rows.push(["Term of Each Purchase", "12 months, paid in instalments on the billing cycle"]);
    rows.push(["Billing Start", "Each purchase is billed from its own purchase date"]);
    rows.push(["Further Purchases", "A new bill with its own billing cycle"]);
    if (config.dueDays !== undefined) rows.push(["Invoice Payment Due", `Net ${config.dueDays} day(s) from invoice date`]);
    if (config.dueDateReminderDaysBefore !== undefined) rows.push(["Due-Date Reminder", `${config.dueDateReminderDaysBefore} day(s) before due date`]);
    if (config.gracePeriodDays !== undefined) rows.push(["Grace Period Before Restriction", `${config.gracePeriodDays} day(s) after due date`]);
    if (config.agreementEndDate) {
      rows.push([
        "Agreement End Date",
        new Date(config.agreementEndDate).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })
      ]);
    }
    if (config.prepayment?.status && config.prepayment.status !== "not_done") {
      rows.push([
        "One-Time Prepayment",
        `Rs. ${config.prepayment.amount || 0} — ${config.prepayment.status === "done" ? "Paid" : "Awaiting payment"}`
      ]);
    }
  }

  return rows;
};

const ENTITY_TYPE_LABEL = {
  proprietorship: "Sole Proprietorship",
  partnership: "Partnership Firm",
  llp: "Limited Liability Partnership",
  private_limited: "Private Limited Company",
  public_limited: "Public Limited Company",
  individual: "Individual",
  other: "Other Business Entity"
};

const formatAddress = (address) => {
  if (!address) return "[Address not on file]";
  const parts = [address.addressLine1, address.addressLine2, address.city, address.state, address.pincode, address.country].filter(Boolean);
  return parts.length ? parts.join(", ") : "[Address not on file]";
};

/**
 * Renders the partner's agreement PDF in memory — the Influencer template
 * for an Influencer, the type-specific sections above for everyone else —
 * stores it in Cloudinary, and returns file metadata in the same shape partnerDocumentController.uploadDocument
 * produces, so the caller can save it as a normal PartnerDocument row.
 */
const generatePartnerAgreementFile = async (partner) => {
  const subfolder = String(partner._id);
  const form = agreementFormFor(partner.partnerType);
  const filename = `${partner.partnerType === "influencer" ? "influencer-agreement" : form.fileSlug}-${Date.now()}.pdf`;

  if (partner.partnerType === "influencer") {
    const [template, settlementSetting] = await Promise.all([
      getAgreementTemplate(),
      SettlementSetting.findOne({ partnerId: partner._id })
    ]);
    const pdf = await renderInfluencerAgreementPdf(partner, template, settlementSetting);
    return storeBuffer(pdf, {
      subfolder,
      filename,
      originalName: `SPOTX ${template.title}.pdf`,
      mimeType: "application/pdf"
    });
  }

  const context = await loadAgreementContext(partner);
  const pricingTermsRows = buildPricingTermsRows(context.pricingPlan, context.billingConfig);

  const effectiveDate = new Date().toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });
  const agreementRef = `SPX-AGR-${partner.partnerCode}`;
  const partnerTypeLabel = partner.partnerType.charAt(0).toUpperCase() + partner.partnerType.slice(1);

  const pdf = await new Promise((resolve, reject) => {
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
    doc.fontSize(16).fillColor(BRAND_BLACK).font("Helvetica-Bold").text(form.title);
    doc.font("Helvetica");
    doc.moveDown(0.15);
    doc.fontSize(9).fillColor(MUTED).text(`Reference: ${agreementRef}    |    Effective Date: ${effectiveDate}`);
    doc.moveDown(0.6);
    doc.strokeColor("#E5E5E5").lineWidth(1).moveTo(56, doc.y).lineTo(539, doc.y).stroke();

    // ---- Preamble ----
    doc.moveDown(0.8);
    body(
      `This ${form.title} ("Agreement") is entered into as of ${effectiveDate}, by and between SPOTX ("SPOTX" or the ` +
      `"Company"), an enterprise digital signage platform operator [Registered Office Address to be inserted], and the ` +
      `${form.party.toLowerCase()} identified below (the "${form.party}", referred to in this Agreement as the "Partner"). ` +
      `It ${form.purpose}. SPOTX and the Partner are individually a "Party" and together the "Parties".`
    );

    // ---- How payment works: which way money moves under THIS form ----
    if (form.paymentSummary.length) {
      doc.moveDown(0.7);
      const boxX = 56;
      const boxWidth = 483;
      const pad = 10;
      const labelWidth = 110;
      const valueWidth = boxWidth - pad * 2 - labelWidth;
      doc.fontSize(9.5);
      const rowHeights = form.paymentSummary.map(([, value]) =>
        Math.max(doc.heightOfString(value, { width: valueWidth }), 12) + 4);
      const boxHeight = pad * 2 + 16 + rowHeights.reduce((a, b) => a + b, 0);
      if (doc.y + boxHeight > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const boxY = doc.y;
      doc.roundedRect(boxX, boxY, boxWidth, boxHeight, 6).fillAndStroke("#F7F7F7", "#E5E5E5");
      doc.fontSize(10).font("Helvetica-Bold").fillColor(BRAND_BLACK).text("How payment works under this Agreement", boxX + pad, boxY + pad);
      let rowY = boxY + pad + 16;
      form.paymentSummary.forEach(([label, value], index) => {
        doc.fontSize(9.5).font("Helvetica-Bold").fillColor(BRAND_BLACK).text(label, boxX + pad, rowY, { width: labelWidth });
        doc.font("Helvetica").fillColor(CHARCOAL).text(value, boxX + pad + labelWidth, rowY, { width: valueWidth });
        rowY += rowHeights[index];
      });
      doc.x = boxX;
      doc.y = boxY + boxHeight;
    }

    // ---- Parties ----
    heading("Parties");
    doc.fontSize(10).fillColor(BRAND_BLACK).font("Helvetica-Bold").text(`The ${form.party}`);
    doc.font("Helvetica").fillColor(CHARCOAL);
    doc.text(`Business / Trade Name: ${partner.legalEntity.businessName}`);
    if (partner.legalEntity.legalName) doc.text(`Registered Legal Name: ${partner.legalEntity.legalName}`);
    doc.text(`Entity Type: ${ENTITY_TYPE_LABEL[partner.legalEntity.entityType] || "Not specified"}`);
    doc.text(`Partner Code: ${partner.partnerCode}`);
    doc.text(`Partner Category: ${partnerTypeLabel}`);
    doc.text(`Registered / Business Address: ${formatAddress(partner.address)}`);
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor(BRAND_BLACK).font("Helvetica-Bold").text("Authorized Representative");
    doc.font("Helvetica").fillColor(CHARCOAL);
    doc.text(`Name: ${partner.primaryContact.name}${partner.primaryContact.designation ? ` (${partner.primaryContact.designation})` : ""}`);
    doc.text(`Email: ${partner.primaryContact.email}`);
    if (partner.primaryContact.phone) doc.text(`Phone: ${partner.primaryContact.phone}`);

    // ---- Body sections ----
    // Each of these can be overridden per partner (see AGREEMENT_SECTIONS /
    // Partner.agreementTerms above) — an admin negotiating different terms
    // with a specific partner edits that partner's copy of this text before
    // the agreement is (re)generated.
    for (const section of AGREEMENT_SECTIONS) {
      heading(section.title(partner));
      const paragraphs = resolveSectionText(partner, section, context).split(/\n{2,}/);
      paragraphs.forEach((paragraph, index) => {
        if (index > 0) doc.moveDown(0.4);
        body(paragraph);
      });

      // Immediately after a Reseller's "Purchase & Payment Terms" prose, lay
      // out their actual current pricing/billing numbers as a table — not
      // just a pointer to "the Panel".
      if (section.key === "payment" && pricingTermsRows.length) {
        doc.moveDown(0.5);
        const labelX = 56;
        const valueX = 260;
        const rowWidth = 483;
        for (const [label, value] of pricingTermsRows) {
          const rowY = doc.y;
          doc.fontSize(9.5).font("Helvetica-Bold").fillColor(BRAND_BLACK).text(label, labelX, rowY, { width: 195 });
          const afterLabelY = doc.y;
          doc.font("Helvetica").fillColor(CHARCOAL).text(value, valueX, rowY, { width: labelX + rowWidth - valueX });
          doc.y = Math.max(afterLabelY, doc.y) + 3;
        }
        doc.moveDown(0.3);
        doc.fontSize(8).fillColor(FAINT).text(
          "These figures reflect the Partner's pricing plan and billing configuration as of the Effective Date above, and " +
          "will be reflected in a reissued Agreement if subsequently changed.",
          labelX,
          doc.y,
          { width: rowWidth, align: "justify" }
        );
        doc.x = labelX;
        doc.moveDown(0.4);
      }
    }

    // ---- Acknowledgement / signature block ----
    doc.moveDown(1.2);
    doc.strokeColor("#E5E5E5").lineWidth(1).moveTo(56, doc.y).lineTo(539, doc.y).stroke();
    doc.moveDown(0.6);
    doc.fontSize(9).fillColor(FAINT).text(
      "This document is generated automatically by the SPOTX Partner Panel upon successful verification of the " +
      "Partner's KYC documents and bank account, and stands as the record of agreed commercial terms between the " +
      "Parties from that point forward. Where a separately signed master agreement exists between the Parties, that " +
      "document takes precedence over this one.",
      { align: "justify", lineGap: 2 }
    );

    doc.moveDown(1.2);
    const colY = doc.y;
    doc.fontSize(9).fillColor(BRAND_BLACK).font("Helvetica-Bold").text("For SPOTX", 56, colY);
    doc.font("Helvetica").fillColor(CHARCOAL).fontSize(9);
    doc.text("Authorized Signatory", 56, colY + 14);
    doc.text(`Verified on: ${effectiveDate}`, 56, colY + 28);

    doc.fontSize(9).fillColor(BRAND_BLACK).font("Helvetica-Bold").text(`For the ${form.party}`, 300, colY);
    doc.font("Helvetica").fillColor(CHARCOAL).fontSize(9);
    doc.text(partner.primaryContact.name, 300, colY + 14);
    doc.text(partner.legalEntity.businessName, 300, colY + 28);

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

  return storeBuffer(pdf, {
    subfolder,
    filename,
    originalName: `SPOTX ${form.title}.pdf`,
    mimeType: "application/pdf"
  });
};

/**
 * Generates the agreement and files it as a normal PartnerDocument, already
 * verified (SPOTX generated it, there's nothing for a reviewer to approve).
 * Idempotent — a partner never gets a second one.
 */
const attachPartnerAgreement = async (partner, adminUserId) => {
  const existing = await PartnerDocument.findOne({ partnerId: partner._id, documentType: "partner_agreement" });
  if (existing) return existing;

  const file = await generatePartnerAgreementFile(partner);

  return PartnerDocument.create({
    partnerId: partner._id,
    documentType: "partner_agreement",
    file,
    verification: {
      status: "verified",
      verifiedBy: adminUserId,
      verifiedAt: new Date()
    }
  });
};

/**
 * Always issues a FRESH agreement — unlike attachPartnerAgreement (which
 * is idempotent and only ever creates one document per partner, used by
 * the non-vendor activation path), this is what backs the vendor
 * custom-commission-assignment flow: every time an admin sets/changes a
 * vendor's commission, the agreement must be reissued to describe the
 * new terms (see the "Entire Agreement" section of the PDF itself, which
 * says exactly this). The new PartnerDocument row sits alongside any
 * earlier ones — the admin/partner UIs already pick the latest by
 * createdAt, so nothing needs to delete the old one.
 *
 * Also writes the PartnerAgreementAcceptance row — acceptance is always
 * automatic (see that model), there is no separate partner sign-off step.
 */
const issuePartnerAgreementForAssignment = async (partner, assignment, adminUserId) => {
  const file = await generatePartnerAgreementFile(partner);

  const document = await PartnerDocument.create({
    partnerId: partner._id,
    documentType: "partner_agreement",
    file,
    verification: {
      status: "verified",
      verifiedBy: adminUserId,
      verifiedAt: new Date()
    }
  });

  const priorVersions = await PartnerAgreementAcceptance.countDocuments({ partnerId: partner._id });
  const version = priorVersions + 1;

  const acceptance = await PartnerAgreementAcceptance.create({
    partnerId: partner._id,
    documentId: document._id,
    commissionAssignmentId: assignment._id,
    agreementRef: `SPX-AGR-${partner.partnerCode}-v${version}`,
    version,
    acceptedBy: "system_auto",
    acceptedAt: new Date()
  });

  return { document, acceptance };
};

/**
 * Issues a fresh Influencer agreement with the current template and rates —
 * called when an admin changes an account's rates or the agreement wording.
 * Only once the influencer already has an agreement (i.e. is verified);
 * before that, activation issues the first one, so this returns null. The
 * admin and influencer UIs show the latest agreement by createdAt, so older
 * versions stay on record.
 */
const reissuePartnerAgreement = async (partner, adminUserId) => {
  const existing = await PartnerDocument.exists({ partnerId: partner._id, documentType: "partner_agreement" });
  if (!existing) return null;
  return regeneratePartnerAgreement(partner, adminUserId);
};

const regeneratePartnerAgreement = async (partner, adminUserId) => {
  const file = await generatePartnerAgreementFile(partner);
  return PartnerDocument.create({
    partnerId: partner._id,
    documentType: "partner_agreement",
    file,
    verification: {
      status: "verified",
      verifiedBy: adminUserId,
      verifiedAt: new Date()
    }
  });
};

module.exports = {
  generatePartnerAgreementFile,
  attachPartnerAgreement,
  issuePartnerAgreementForAssignment,
  regeneratePartnerAgreement,
  reissuePartnerAgreement,
  // The Influencer template renderer, for the admin's wording preview.
  renderAgreementPdf: renderInfluencerAgreementPdf,
  AGREEMENT_SECTIONS,
  loadAgreementContext,
  resolveSectionText
};
