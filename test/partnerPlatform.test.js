const assert = require("node:assert/strict");
const test = require("node:test");

const { PARTNER_TYPES } = require("../config/constant");
const Partner = require("../models/Partner");
const PartnerCommission = require("../models/Partnercommission");
const PartnerUser = require("../models/Partneruser");
const PartnerActivity = require("../models/Partneractivity");
const AgreementTemplate = require("../models/AgreementTemplate");
const { DEFAULT_TEMPLATE, validateTemplate } = require("../services/agreementTemplate");
const { renderAgreementPdf } = require("../services/influencerAgreement");
const requireInfluencerPartner = require("../middleware/requireInfluencerPartner");

test("the platform exposes exactly the four unified partner types", () => {
  assert.deepEqual(PARTNER_TYPES, ["vendor", "influencer", "affiliate", "reseller"]);
  assert.deepEqual(Partner.schema.path("partnerType").enumValues, PARTNER_TYPES);
});

test("partner model stores influencer accounts in the shared Partner schema", () => {
  assert.ok(Partner.schema.path("socialAccounts"));
  assert.ok(Partner.schema.path("socialAccounts").schema.path("accessTokenEncrypted").options.select === false);
});

test("partner email identity is unique across partner types", () => {
  const hasGlobalUniqueEmailIndex = PartnerUser.schema.indexes().some(([fields, options]) =>
    fields.email === 1 && options.unique === true
  );
  assert.equal(hasGlobalUniqueEmailIndex, true);
});

test("influencer content and affiliate rewards are idempotently linked to ledger entries", () => {
  const commissionIndexes = PartnerCommission.schema.indexes();
  assert.ok(commissionIndexes.some(([fields, options]) => fields.submissionId === 1 && options.unique && options.sparse));
  assert.ok(commissionIndexes.some(([fields, options]) => fields.referralId === 1 && options.unique && options.sparse));
});

test("reseller duplicate invoice cleanup activity passes model validation", async () => {
  const activity = new PartnerActivity({
    partnerId: "000000000000000000000001",
    performedBy: { type: "system" },
    activityType: "reseller_invoice_duplicates_removed"
  });
  await assert.doesNotReject(() => activity.validate());
});

test("social workflow rejects non-influencer partner types", () => {
  let statusCode;
  let nextCalled = false;
  const response = { status(code) { statusCode = code; return this; }, json() { return this; } };
  requireInfluencerPartner({ partner: { partnerType: "vendor" } }, response, () => { nextCalled = true; });
  assert.equal(statusCode, 403);
  assert.equal(nextCalled, false);

  requireInfluencerPartner({ partner: { partnerType: "influencer" } }, response, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test("influencer agreement template validates and renders a PDF", async () => {
  assert.ok(AgreementTemplate.schema.path("sections"));
  const [template, error] = validateTemplate(DEFAULT_TEMPLATE);
  assert.equal(error, null);
  const pdf = await renderAgreementPdf({
    _id: "000000000000000000000001",
    partnerCode: "PTN-SAMPLE",
    primaryContact: { name: "Sample Influencer", email: "sample@example.com", phone: "" },
    address: { city: "Mumbai", state: "Maharashtra", country: "India" },
    socialAccounts: []
  }, template, null);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});

/* ---- Rules that keep the four partner types apart, and shared features ---- */

const fs = require("node:fs");
const path = require("node:path");
const requirePartnerType = require("../middleware/requirePartnerType");
const { isProfileComplete } = require("../utils/partnerVerification");
const notifyAdmins = require("../utils/notifyAdmins");
const AdminNotification = require("../models/AdminNotification");
const {
  PartnerBankAccount, PartnerTier, CommissionRule, SettlementSetting
} = require("../models/Index");
const PartnerCommissionAssignment = require("../models/PartnerCommissionAssignment");
const ResellerPricingPlan = require("../models/ResellerPricingPlan");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");
const {
  AGREEMENT_SECTIONS, resolveSectionText, generatePartnerAgreementFile
} = require("../services/generatePartnerAgreement");
const { registerPartnerValidator } = require("../validations/partnerAuthValidator");
const { Writable } = require("node:stream");
const cloudinary = require("cloudinary").v2;
const { requireFileStorage } = require("../utils/fileStorage");

const runGuard = (guard, partnerType) => {
  let statusCode = null;
  let nextCalled = false;
  const response = { status(code) { statusCode = code; return this; }, json() { return this; } };
  guard({ partner: { partnerType } }, response, () => { nextCalled = true; });
  return { statusCode, nextCalled };
};

test("type-specific partner APIs are guarded on the server, not just hidden in the menu", () => {
  const affiliateOnly = requirePartnerType("affiliate");
  assert.equal(runGuard(affiliateOnly, "affiliate").nextCalled, true);
  for (const type of ["vendor", "influencer", "reseller"]) {
    assert.equal(runGuard(affiliateOnly, type).statusCode, 403);
  }

  const earningTypes = requirePartnerType("influencer", "affiliate", "vendor");
  assert.equal(runGuard(earningTypes, "reseller").statusCode, 403);
  assert.equal(runGuard(earningTypes, "vendor").nextCalled, true);

  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  assert.match(indexSource, /"\/api\/partner\/referrals", verifiedGuard, requirePartnerType\("affiliate"\)/);
  assert.match(indexSource, /"\/api\/partner\/customers", verifiedGuard, requirePartnerType\("vendor"\)/);
  assert.match(indexSource, /"\/api\/partner\/team", verifiedGuard, partnerUserRoutes/);
});

test("profile completeness follows the partner type", () => {
  const named = { legalEntity: { businessName: "Acme" }, address: {} };
  assert.equal(isProfileComplete({ ...named, partnerType: "vendor" }), true);
  assert.equal(isProfileComplete({ ...named, partnerType: "influencer" }), false);
  assert.equal(isProfileComplete({ ...named, partnerType: "influencer", address: { state: "Goa", city: "Panaji" } }), true);
  assert.equal(isProfileComplete({ partnerType: "affiliate", legalEntity: {}, address: { state: "Goa", city: "Panaji" } }), false);
});

test("GST and MSME: compulsory for vendor and reseller, optional for affiliate, not applicable to influencer", () => {
  const { getRequiredDocumentTypes, getNotApplicableDocumentTypes, isDocumentTypeApplicable } = require("../utils/partnerVerification");
  const business = ["msme_udyam", "gst_certificate"];

  for (const type of ["vendor", "reseller"]) {
    for (const doc of business) assert.ok(getRequiredDocumentTypes(type).includes(doc), `${type} must provide ${doc}`);
  }
  for (const doc of business) {
    // Affiliate: may upload, never required.
    assert.equal(getRequiredDocumentTypes("affiliate").includes(doc), false);
    assert.equal(isDocumentTypeApplicable("affiliate", doc), true);
    // Influencer: neither required nor accepted.
    assert.equal(getRequiredDocumentTypes("influencer").includes(doc), false);
    assert.equal(isDocumentTypeApplicable("influencer", doc), false);
  }
  assert.deepEqual(getNotApplicableDocumentTypes("influencer"), business);
  assert.deepEqual(getNotApplicableDocumentTypes("vendor"), []);
  // Everyone still needs identity + bank proof.
  for (const type of ["influencer", "affiliate", "vendor", "reseller"]) {
    assert.ok(getRequiredDocumentTypes(type).includes("pan_card"));
    assert.ok(getRequiredDocumentTypes(type).includes("cancelled_cheque"));
  }
});

test("admin notifications cover every partner type and carry a role audience", () => {
  assert.ok(AdminNotification.schema.path("audienceRoles"));
  assert.equal(notifyAdmins.partnerLabel({ partnerType: "reseller", partnerCode: "PTN-1", legalEntity: {}, primaryContact: {} }), "A reseller (PTN-1)");
  assert.equal(notifyAdmins.partnerLabel({ partnerCode: "PTN-2", legalEntity: { businessName: "Acme" } }), "Acme (PTN-2)");
});

test("reseller bank changes are staged on the bank account", () => {
  const pendingChange = PartnerBankAccount.schema.path("pendingChange");
  assert.ok(pendingChange);
  assert.equal(pendingChange.schema.path("accountNumberEncrypted").options.select, false);
});

test("registration validation accepts the four partner types only", async () => {
  const run = async (body) => {
    const req = { body };
    let statusCode = null;
    let passed = false;
    const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
    const steps = [...registerPartnerValidator];
    const finalCheck = steps.pop();
    // express-validator chains are middleware that return a promise.
    for (const step of steps) await step(req, res, () => {});
    finalCheck(req, res, () => { passed = true; });
    return { statusCode, passed };
  };

  const valid = { contactName: "A", email: "a@example.com", phone: "9999999999", password: "password1" };
  for (const partnerType of PARTNER_TYPES) {
    assert.equal((await run({ ...valid, partnerType })).passed, true, partnerType);
  }
  assert.equal((await run({ ...valid, partnerType: "agency" })).statusCode, 400);
  assert.equal((await run({ ...valid, partnerType: "vendor", password: "short" })).statusCode, 400);
});

test("agreement sections differ by partner type and honour per-partner overrides", () => {
  const context = { tier: null, rule: null, settlementCadence: "Monthly", tdsNote: "" };
  const base = { primaryContact: { email: "p@example.com" }, agreementTerms: {} };
  const payment = AGREEMENT_SECTIONS.find((section) => section.key === "payment");

  const reseller = { ...base, partnerType: "reseller" };
  const vendor = { ...base, partnerType: "vendor" };
  assert.equal(payment.title(reseller), "Purchase & Payment Terms");
  assert.equal(payment.title(vendor), "Commission & Payment Terms");
  assert.match(resolveSectionText(reseller, payment, context), /purchases SPOTX screen software licenses/);
  assert.match(resolveSectionText(vendor, payment, context), /Commission is calculated/);

  // Affiliates earn a Referral Reward set per won deal — never the Vendor's
  // commission-rule wording.
  const affiliate = { ...base, partnerType: "affiliate" };
  assert.equal(payment.title(affiliate), "Referral Reward & Payment Terms");
  assert.match(resolveSectionText(affiliate, payment, context), /one-time Referral Reward/);
  assert.doesNotMatch(resolveSectionText(affiliate, payment, context), /commission/i);
  assert.doesNotMatch(resolveSectionText(reseller, payment, context), /commission/i);

  const texts = ["vendor", "affiliate", "reseller"].map((partnerType) =>
    AGREEMENT_SECTIONS.map((section) => resolveSectionText({ ...base, partnerType }, section, context)).join("\n"));
  assert.equal(new Set(texts).size, 3, "each partner type must get its own agreement wording");

  const negotiated = { ...vendor, agreementTerms: { payment: "Negotiated terms." } };
  assert.equal(resolveSectionText(negotiated, payment, context), "Negotiated terms.");
  // A blank override falls back to the standard wording.
  assert.match(resolveSectionText({ ...vendor, agreementTerms: { payment: "  " } }, payment, context), /Commission is calculated/);
});

test("each non-influencer partner type's agreement renders and is stored in Cloudinary, not on disk", async (t) => {
  // No database or network in this test — the lookups the generator makes
  // and the Cloudinary upload are stubbed.
  const noAssignment = () => {
    const query = Promise.resolve(null);
    query.sort = () => query;
    query.lean = () => query;
    return query;
  };
  t.mock.method(PartnerTier, "findById", async () => null);
  t.mock.method(CommissionRule, "findOne", () => ({ sort: async () => null }));
  t.mock.method(SettlementSetting, "findOne", async () => null);
  t.mock.method(PartnerCommissionAssignment, "findOne", noAssignment);
  t.mock.method(ResellerPricingPlan, "findOne", async () => ({
    pricingMode: "discount_percent", standardPricePerScreen: 500, wholesaleDiscountPercent: 20,
    effectivePricePerScreen: 400, minPurchaseQty: 10, taxRatePercent: 18,
    bulkTiers: [{ minQty: 50, pricePerScreen: 350 }], bulkTierBasis: "per_order"
  }));
  t.mock.method(ResellerBillingConfig, "findOne", async () => ({
    billingCycle: "monthly", billingStartRule: "on_first_purchase", prorationRule: "none",
    dueDays: 7, dueDateReminderDaysBefore: 3, gracePeriodDays: 3, prepayment: { status: "done", amount: 1000 }
  }));

  const saved = { ...process.env };
  process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
  process.env.CLOUDINARY_API_KEY = "test-key";
  process.env.CLOUDINARY_API_SECRET = "test-secret";
  t.after(() => {
    for (const key of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const uploads = [];
  t.mock.method(cloudinary.uploader, "upload_stream", (options, callback) => {
    const chunks = [];
    return new Writable({
      write(chunk, encoding, done) { chunks.push(chunk); done(); },
      final(done) {
        uploads.push({ options, body: Buffer.concat(chunks) });
        callback(null, { public_id: options.public_id });
        done();
      }
    });
  });

  const ids = { vendor: "0000000000000000000000a1", affiliate: "0000000000000000000000a3", reseller: "0000000000000000000000a2" };
  for (const partnerType of ["vendor", "affiliate", "reseller"]) {
    const partner = {
      _id: ids[partnerType],
      partnerType,
      partnerCode: "PTN-TEST",
      legalEntity: { businessName: "Test Partner", entityType: "private_limited" },
      primaryContact: { name: "Test Contact", email: "test@example.com", phone: "" },
      address: { city: "Mumbai", state: "Maharashtra", country: "India" },
      program: {},
      agreementTerms: { confidentiality: "Custom confidentiality clause." }
    };
    const file = await generatePartnerAgreementFile(partner);
    const upload = uploads.at(-1);

    assert.equal(file.storageProvider, "cloudinary");
    assert.equal(file.objectKey, upload.options.public_id);
    // Each type's agreement is its own form, named for how money moves.
    const form = {
      vendor: ["vendor-commission-agreement", "SPOTX Vendor Commission Agreement.pdf"],
      affiliate: ["affiliate-referral-agreement", "SPOTX Affiliate Referral Agreement.pdf"],
      reseller: ["reseller-licence-purchase-agreement", "SPOTX Reseller Licence Purchase Agreement.pdf"]
    }[partnerType];
    assert.match(file.objectKey, new RegExp(`/partners/${ids[partnerType]}/${form[0]}-\\d+\\.pdf$`));
    assert.equal(file.originalName, form[1]);
    assert.equal(upload.options.type, "private");
    assert.equal(upload.body.subarray(0, 5).toString(), "%PDF-");
    assert.equal(file.size, upload.body.length);
    // Nothing is left behind on this server's disk.
    assert.equal(fs.existsSync(path.join(__dirname, "..", "uploads", "partners", ids[partnerType])), false);
  }
  assert.equal(uploads.length, 3);
});

test("uploads are refused up front when Cloudinary isn't configured", (t) => {
  const saved = process.env.CLOUDINARY_CLOUD_NAME;
  delete process.env.CLOUDINARY_CLOUD_NAME;
  t.after(() => { if (saved !== undefined) process.env.CLOUDINARY_CLOUD_NAME = saved; });

  let statusCode = null;
  let nextCalled = false;
  const res = { status(code) { statusCode = code; return this; }, json() { return this; } };
  requireFileStorage({}, res, () => { nextCalled = true; });
  assert.equal(statusCode, 503);
  assert.equal(nextCalled, false);
});

test("a staged reseller bank change carries its own Rs.1 verification check", () => {
  const pendingChange = PartnerBankAccount.schema.path("pendingChange");
  assert.ok(pendingChange.schema.path("razorpayCheck.paymentStatus"));
  assert.ok(pendingChange.schema.path("razorpayCheck.orderId"));
});
