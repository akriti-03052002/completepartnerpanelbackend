const PartnerSettlementHistory = require("../models/PartnerSettlementHistory");

/* ============================================================
   SETTLEMENT HISTORY RECORDER
   Single write path into PartnerSettlementHistory so every call site
   (controllers + settlementHold.js) logs events in the same shape.
   Never throws into the caller — a history write failing shouldn't ever
   block the actual settlement action from completing.
============================================================ */

const recordSettlementHistory = async (settlement, {
  action, fromStatus, toStatus, reason, amount, meta, byUserId, byPartnerUser, req
} = {}) => {
  try {
    const performedByType = byPartnerUser ? "partner_user" : byUserId ? "spotx_user" : "system";

    await PartnerSettlementHistory.create({
      settlementId: settlement._id,
      partnerId: settlement.partnerId,
      action,
      fromStatus: fromStatus || "",
      toStatus: toStatus || "",
      reason: reason || "",
      amount: amount || undefined,
      meta: meta || {},
      performedByType,
      performedByUserId: byPartnerUser || byUserId || undefined,
      ipAddress: req?.ip || ""
    });
  } catch (error) {
    console.error("recordSettlementHistory failed:", error.message);
  }
};

const getSettlementHistory = (settlementId) =>
  PartnerSettlementHistory.find({ settlementId }).sort({ createdAt: 1 }).lean();

module.exports = { recordSettlementHistory, getSettlementHistory };
