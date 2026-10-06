const AgreementTemplate = require("../models/AgreementTemplate");

/**
 * Placeholders an admin can use anywhere in the agreement text. Each is
 * filled in per influencer when the PDF is generated.
 */
const PLACEHOLDERS = {
  companyName: "Your company name (set above)",
  registeredAddress: "Your registered office address (set above)",
  influencerName: "The influencer's full name",
  influencerEmail: "The influencer's email",
  influencerCode: "The influencer's code, e.g. PTN-12345678",
  effectiveDate: "The date the agreement is issued",
  settlementCycle: "How often settlements are paid, e.g. monthly",
  taxNote: "The TDS sentence for this influencer's tax settings"
};

// Today's agreement wording — what a fresh install starts with, and what
// "Reset to default" restores.
const DEFAULT_TEMPLATE = {
  title: "Influencer Agreement",
  companyName: "SPOTX",
  registeredAddress: "",
  intro:
    'This Influencer Agreement ("Agreement") is entered into as of {{effectiveDate}}, by and between {{companyName}} ' +
    '("{{companyName}}" or the "Company"), an enterprise digital signage platform operator with its registered office at ' +
    '{{registeredAddress}}, and the content creator identified below ("Influencer"). {{companyName}} and the Influencer ' +
    'are individually a "Party" and together the "Parties".',
  sections: [
    {
      kind: "text",
      heading: "Background",
      body:
        "{{companyName}} operates an enterprise-grade digital signage platform that enables businesses to manage content, " +
        "monitor screens, schedule campaigns, and track performance across their screen network from a single dashboard. " +
        "The Influencer creates content for an audience on social media and wishes to promote {{companyName}} to that " +
        "audience. {{companyName}} is willing to pay the Influencer for approved promotional content on the terms of this Agreement."
    },
    {
      kind: "text",
      heading: "Scope of Work",
      body:
        "The Influencer will create and publish posts and reels promoting {{companyName}} on the social media accounts " +
        "listed in the Payment Terms section below, and submit each published piece through the {{companyName}} " +
        "Influencer Panel for review. {{companyName}} reviews every submission and approves or rejects it; only approved " +
        "content is paid. In creating content, the Influencer will:",
      bullets: [
        "publish only from social accounts that {{companyName}} has verified as belonging to the Influencer;",
        'clearly disclose the paid nature of the content (for example "#ad" or the platform\'s paid-partnership label), in line with the ASCI Guidelines for Influencer Advertising in Digital Media;',
        "represent {{companyName}}'s products, features, and pricing accurately, and not make claims {{companyName}} has not approved;",
        "keep follower and engagement figures genuine — no purchased followers, bots, or artificial engagement."
      ]
    },
    {
      kind: "text",
      heading: "Onboarding & Verification",
      body:
        "This Agreement, and the Influencer's ability to submit content and receive payouts through the {{companyName}} " +
        "Influencer Panel, is conditioned on {{companyName}}'s verification of the Influencer's KYC documents, bank account " +
        "details, and social media accounts. The Influencer represents and warrants that all information and documents " +
        "submitted for this purpose are true, accurate, and not misleading. {{companyName}} reserves the right to suspend " +
        "or reject the Influencer's account if this is found not to be the case."
    },
    {
      kind: "payment_rates",
      heading: "Payment Terms",
      body:
        "The Influencer is paid a fixed amount for each approved piece of content, at the rate agreed below for the social " +
        "account it was published on. These rates apply to every approved post and reel from that account — no separate " +
        "price is set per piece of content.",
      noRatesText:
        "Payment rates for the Influencer's social accounts have not been set yet. {{companyName}} will agree per-post and " +
        "per-reel rates for each account before any content becomes payable, and this Agreement will be reissued to state them.",
      note:
        "A payment is recorded when {{companyName}} approves a submitted post or reel, and becomes eligible for settlement " +
        "after {{companyName}}'s internal review. Settlements are processed on a {{settlementCycle}} basis to the bank " +
        "account verified by the Influencer in the {{companyName}} Influencer Panel. {{taxNote}} {{companyName}} reserves " +
        "the right to hold or reverse any payment connected to content that is removed, misrepresented, or found to be fraudulent."
    },
    {
      kind: "text",
      heading: "Term & Termination",
      body:
        "This Agreement commences on the Effective Date and continues until terminated by either Party. Either Party may " +
        "terminate this Agreement for convenience upon thirty (30) days' prior written notice to the other Party. " +
        "{{companyName}} may suspend or terminate this Agreement immediately upon written notice if the Influencer breaches " +
        "this Agreement, provides false information, or engages in fraudulent or unlawful conduct. Termination does not " +
        "affect payment already earned for content approved prior to the effective date of termination, which remains " +
        "payable per the settlement terms above."
    },
    {
      kind: "text",
      heading: "Confidentiality",
      body:
        "Each Party agrees to keep confidential all non-public business, technical, and financial information disclosed by " +
        "the other Party in connection with this Agreement, including the payment rates set out above, and to use such " +
        "information solely to perform its obligations under this Agreement. This obligation survives termination of this Agreement."
    },
    {
      kind: "text",
      heading: "Intellectual Property & Content Use",
      body:
        "{{companyName}} retains all right, title, and interest in and to its platform, software, trademarks, and brand " +
        "assets. The Influencer is granted a limited, non-exclusive, non-transferable right to use {{companyName}}'s name " +
        "and marks solely in content created under this Agreement, in accordance with {{companyName}}'s brand guidelines; " +
        "this right ends automatically when this Agreement ends. The Influencer retains ownership of the content it creates, " +
        "and grants {{companyName}} a non-exclusive right to share or link to approved content on {{companyName}}'s own " +
        "channels with credit to the Influencer."
    },
    {
      kind: "text",
      heading: "Compliance",
      body:
        "Each Party will comply with applicable law in performing its obligations under this Agreement, including consumer " +
        "protection and advertising disclosure rules and each social media platform's own terms for branded content. The " +
        "Influencer is responsible for its own tax filings on payments received under this Agreement."
    },
    {
      kind: "text",
      heading: "Limitation of Liability",
      body:
        "Neither Party will be liable to the other for any indirect, incidental, or consequential damages arising out of " +
        "this Agreement. Each Party's total liability under this Agreement is limited to the amounts actually paid or " +
        "payable to the Influencer in the twelve (12) months preceding the event giving rise to the claim."
    },
    {
      kind: "text",
      heading: "Governing Law & Dispute Resolution",
      body:
        "This Agreement is governed by the laws of India. The Parties will first attempt to resolve any dispute arising out " +
        "of this Agreement through good-faith discussion, failing which the dispute will be subject to the exclusive " +
        "jurisdiction of the competent courts in India."
    },
    {
      kind: "text",
      heading: "Notices",
      body:
        "Notices under this Agreement will be sent to the Influencer at {{influencerEmail}} and will be deemed delivered " +
        "when sent. {{companyName}} may also notify the Influencer in-app via the {{companyName}} Influencer Panel."
    },
    {
      kind: "text",
      heading: "Entire Agreement",
      body:
        "This Agreement, generated by the {{companyName}} Influencer Panel, reflects the terms configured for the Influencer " +
        "as of the Effective Date and constitutes the entire understanding between the Parties regarding the subject matter " +
        "herein. Whenever {{companyName}} changes the Influencer's payment rates, a reissued version of this Agreement " +
        "stating the new rates replaces this one for content approved after its effective date."
    }
  ],
  footerNote:
    "This document is generated automatically by the {{companyName}} Influencer Panel upon verification of the " +
    "Influencer's KYC documents and bank account, and is reissued whenever the agreed payment rates change. Where a " +
    "separately signed master agreement exists between the Parties, that document takes precedence over this one."
};

const toPlain = (template) => ({
  title: template.title,
  companyName: template.companyName,
  registeredAddress: template.registeredAddress,
  intro: template.intro,
  sections: template.sections.map((s) => ({
    kind: s.kind || "text",
    heading: s.heading,
    body: s.body || "",
    bullets: [...(s.bullets || [])],
    note: s.note || "",
    noRatesText: s.noRatesText || ""
  })),
  footerNote: template.footerNote,
  updatedAt: template.updatedAt
});

/** The saved template, or the default wording if an admin never edited it. */
const getAgreementTemplate = async () => {
  const saved = await AgreementTemplate.findOne().lean();
  return saved ? toPlain(saved) : { ...DEFAULT_TEMPLATE, sections: DEFAULT_TEMPLATE.sections.map((s) => ({ bullets: [], note: "", noRatesText: "", ...s })) };
};

const LIMITS = { title: 120, company: 120, address: 300, heading: 120, text: 6000, bullet: 600, sections: 40, bullets: 20 };

/**
 * Cleans an admin's submitted template and returns [template, error].
 * Exactly one Payment Terms section is required — it's where each
 * account's rates are printed.
 */
const validateTemplate = (input) => {
  const str = (v) => String(v ?? "").trim();
  const title = str(input?.title);
  if (!title || title.length > LIMITS.title) return [null, "Give the agreement a title (up to 120 characters)."];
  const companyName = str(input.companyName);
  if (!companyName || companyName.length > LIMITS.company) return [null, "Enter the company name (up to 120 characters)."];
  const registeredAddress = str(input.registeredAddress);
  if (registeredAddress.length > LIMITS.address) return [null, "The registered address is too long (up to 300 characters)."];
  const intro = str(input.intro);
  const footerNote = str(input.footerNote);
  if (intro.length > LIMITS.text || footerNote.length > LIMITS.text) return [null, "The opening paragraph or closing note is too long."];

  if (!Array.isArray(input.sections) || input.sections.length === 0) return [null, "Add at least one section."];
  if (input.sections.length > LIMITS.sections) return [null, "An agreement can have at most 40 sections."];

  const sections = [];
  for (const [i, raw] of input.sections.entries()) {
    const kind = raw?.kind === "payment_rates" ? "payment_rates" : "text";
    const heading = str(raw?.heading);
    if (!heading || heading.length > LIMITS.heading) return [null, `Section ${i + 1} needs a heading (up to 120 characters).`];
    const body = str(raw.body);
    const note = str(raw.note);
    const noRatesText = str(raw.noRatesText);
    if ([body, note, noRatesText].some((t) => t.length > LIMITS.text)) return [null, `The text in "${heading}" is too long.`];
    const bullets = (Array.isArray(raw.bullets) ? raw.bullets : []).map(str).filter(Boolean);
    if (bullets.length > LIMITS.bullets || bullets.some((b) => b.length > LIMITS.bullet)) {
      return [null, `"${heading}" can have up to 20 bullet points of 600 characters each.`];
    }
    if (kind === "text" && !body && bullets.length === 0) return [null, `"${heading}" has no text. Add some or remove the section.`];
    sections.push({ kind, heading, body, bullets, note, noRatesText });
  }

  if (sections.filter((s) => s.kind === "payment_rates").length !== 1) {
    return [null, "Keep exactly one Payment Terms section — it's where each account's rates are listed."];
  }

  return [{ title, companyName, registeredAddress, intro, sections, footerNote }, null];
};

const saveAgreementTemplate = async (template, adminUserId) => {
  const saved = await AgreementTemplate.findOneAndUpdate(
    {},
    { $set: { ...template, updatedBy: adminUserId } },
    { upsert: true, returnDocument: "after", runValidators: true }
  ).lean();
  return toPlain(saved);
};

module.exports = { PLACEHOLDERS, DEFAULT_TEMPLATE, getAgreementTemplate, validateTemplate, saveAgreementTemplate };
