const mongoose = require("mongoose");
const { Partner, PartnerDocument, PartnerNotification, SettlementSetting } = require("../models/Index");
const { AgreementTemplate } = require("../models/Index");
const {
  PLACEHOLDERS, DEFAULT_TEMPLATE, getAgreementTemplate, validateTemplate, saveAgreementTemplate
} = require("../services/agreementTemplate");
const { renderAgreementPdf, reissuePartnerAgreement } = require("../services/generatePartnerAgreement");

/* ============================================================
   ADMIN — INFLUENCER AGREEMENT TEMPLATE
   The wording of the agreement PDF is edited here; new agreements
   always use the latest saved version.
============================================================ */

// Stand-in influencer for previews when no real one is picked, so the
// preview still shows the Parties block and a rate list.
const SAMPLE_INFLUENCER = {
  _id: new mongoose.Types.ObjectId(),
  partnerCode: "PTN-SAMPLE",
  legalEntity: { legalName: "" },
  primaryContact: { name: "Sample Influencer", email: "influencer@example.com", phone: "+91 90000 00000" },
  address: { city: "Mumbai", state: "Maharashtra", country: "India" },
  socialAccounts: [
    { platform: "instagram", username: "sample.creator", reviewStatus: "verified", paymentRates: { post: 8000, reel: 15000 } },
    { platform: "youtube", username: "SampleCreatorVlogs", reviewStatus: "verified", paymentRates: { post: 6000, reel: 10000 } }
  ]
};

const getTemplate = async (req, res) => {
  const [template, savedCount] = await Promise.all([getAgreementTemplate(), AgreementTemplate.countDocuments()]);
  return res.json({
    success: true,
    data: { template, placeholders: PLACEHOLDERS, isDefault: savedCount === 0 }
  });
};

/**
 * Reissues the agreement to every influencer who already has one, so their
 * copy uses the new wording. Returns how many were reissued.
 */
const reissueAll = async (adminUserId) => {
  const partnerIds = await PartnerDocument.distinct("partnerId", { documentType: "partner_agreement" });
  let count = 0;
  for (const partnerId of partnerIds) {
    // eslint-disable-next-line no-await-in-loop
    const partner = await Partner.findOne({ _id: partnerId, partnerType: "influencer", status: "active" });
    if (!partner) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const agreement = await reissuePartnerAgreement(partner, adminUserId);
      if (!agreement) continue;
      count += 1;
      // eslint-disable-next-line no-await-in-loop
      await PartnerNotification.create({
        partnerId: partner._id,
        type: "partner_agreement_issued",
        title: "Your Influencer Agreement was updated",
        message: "SPOTX updated the terms of your Influencer Agreement. The new version is in Documents.",
        entity: { type: "PartnerDocument", entityId: agreement._id }
      });
    } catch (error) {
      console.error(`reissueAll: agreement for ${partnerId} failed:`, error.message);
    }
  }
  return count;
};

const updateTemplate = async (req, res) => {
  try {
    const [template, error] = validateTemplate(req.body.template);
    if (error) return res.status(400).json({ success: false, message: error });

    const saved = await saveAgreementTemplate(template, req.adminUser._id);
    const reissued = req.body.reissueExisting === true ? await reissueAll(req.adminUser._id) : 0;

    return res.json({
      success: true,
      message: req.body.reissueExisting === true
        ? `Agreement saved and reissued to ${reissued} verified influencer${reissued === 1 ? "" : "s"}.`
        : "Agreement saved. New agreements will use this wording.",
      data: { template: saved, reissued }
    });
  } catch (error) {
    console.error("updateTemplate error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong saving the agreement." });
  }
};

const resetTemplate = async (req, res) => {
  await AgreementTemplate.deleteMany({});
  return res.json({ success: true, message: "Agreement reset to the default wording.", data: { template: DEFAULT_TEMPLATE } });
};

// Renders the draft being edited (not yet saved) as a PDF, for a chosen
// influencer or the sample one.
const previewTemplate = async (req, res) => {
  try {
    const [template, error] = validateTemplate(req.body.template);
    if (error) return res.status(400).json({ success: false, message: error });

    let partner = SAMPLE_INFLUENCER;
    if (req.body.partnerId) {
      if (!mongoose.Types.ObjectId.isValid(req.body.partnerId)) {
        return res.status(400).json({ success: false, message: "Invalid influencer." });
      }
      partner = await Partner.findById(req.body.partnerId);
      if (!partner) return res.status(404).json({ success: false, message: "Influencer not found." });
      if (partner.partnerType !== "influencer") {
        return res.status(400).json({ success: false, message: "Choose an influencer to preview this agreement." });
      }
    }
    const settlementSetting = partner === SAMPLE_INFLUENCER ? null : await SettlementSetting.findOne({ partnerId: partner._id });

    const pdf = await renderAgreementPdf(partner, template, settlementSetting);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="agreement-preview.pdf"');
    return res.send(pdf);
  } catch (error) {
    console.error("previewTemplate error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong building the preview." });
  }
};

module.exports = { getTemplate, updateTemplate, resetTemplate, previewTemplate };
