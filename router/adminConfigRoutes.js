const express = require("express");
const router = express.Router();

const {
  listPrograms, createProgram, updateProgram,
  listTiers, createTier, updateTier,
  listCommissionRules, createCommissionRule, updateCommissionRule,
  listSettlementSettings, upsertSettlementSetting,
  getScreenPricing, updateScreenPricing,
  getPaymentGatewaySettings, updatePaymentGatewaySettings
} = require("../controller/adminConfigController");
const { getTemplate, updateTemplate, resetTemplate, previewTemplate } = require("../controller/adminAgreementController");
const requireAdminRole = require("../middleware/requireAdminRole");

router.get("/programs", requireAdminRole("kyc_reviewer", "finance"), listPrograms);
router.post("/programs", requireAdminRole(), createProgram);
router.patch("/programs/:id", requireAdminRole(), updateProgram);

router.get("/tiers", requireAdminRole("kyc_reviewer", "finance"), listTiers);
router.post("/tiers", requireAdminRole(), createTier);
router.patch("/tiers/:id", requireAdminRole(), updateTier);

router.get("/commission-rules", requireAdminRole("finance"), listCommissionRules);
router.post("/commission-rules", requireAdminRole("finance"), createCommissionRule);
router.patch("/commission-rules/:id", requireAdminRole("finance"), updateCommissionRule);

router.get("/settlement-settings", requireAdminRole("finance"), listSettlementSettings);
router.put("/settlement-settings", requireAdminRole("finance"), upsertSettlementSetting);

router.get("/screen-pricing", requireAdminRole("finance"), getScreenPricing);
router.put("/screen-pricing", requireAdminRole("finance"), updateScreenPricing);

router.get("/payment-gateway", requireAdminRole("finance"), getPaymentGatewaySettings);
router.put("/payment-gateway", requireAdminRole("finance"), updatePaymentGatewaySettings);

router.get("/agreement-template", requireAdminRole("kyc_reviewer", "finance"), getTemplate);
router.post("/agreement-template/preview", requireAdminRole("kyc_reviewer", "finance"), previewTemplate);
router.put("/agreement-template", requireAdminRole(), updateTemplate);
router.post("/agreement-template/reset", requireAdminRole(), resetTemplate);

module.exports = router;
