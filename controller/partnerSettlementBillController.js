const { PartnerSettlement } = require("../models/Index");
const PartnerSettlementBill = require("../models/PartnerSettlementBill");
const { GST_RATE_PERCENT } = require("../config/constant");
const logActivity = require("../utils/logActivity");
const { storeUploadedFile } = require("../utils/fileStorage");
const notifyAdmins = require("../utils/notifyAdmins");
const { partnerLabel } = notifyAdmins;
const { recordSettlementHistory } = require("../utils/settlementHistory");

/* ============================================================
   PARTNER — SETTLEMENT BILL SUBMISSION
   A GST-registered partner submits one bill per settlement batch (see
   utils/settlementHold.checkBillRequirement for who this applies to and
   what blocks payout without one). The bill amount is always
   server-computed off the settlement's own gross commission + the shared
   GST_RATE_PERCENT constant — never taken from the partner's input, same
   "never trust the client for money" rule as everywhere else Razorpay
   touches this app.
============================================================ */

const round2 = (n) => Math.round(n * 100) / 100;

const submitBill = async (req, res) => {
  try {
    const { billNumber, billDate, gstin } = req.body;

    if (!billNumber || !billDate || !gstin) {
      return res.status(400).json({ success: false, message: "Bill number, bill date, and GSTIN are all required." });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: "A bill file is required." });
    }

    const settlement = await PartnerSettlement.findOne({ _id: req.params.id, partnerId: req.partner._id });

    if (!settlement) {
      return res.status(404).json({ success: false, message: "Settlement not found." });
    }

    if (["paid", "cancelled"].includes(settlement.status)) {
      return res.status(400).json({ success: false, message: `A bill can't be submitted for a settlement that's already ${settlement.status}.` });
    }

    const existing = await PartnerSettlementBill.findOne({ settlementId: settlement._id });
    if (existing && existing.status !== "rejected") {
      return res.status(400).json({ success: false, message: `A bill has already been ${existing.status} for this settlement.` });
    }

    const commission = settlement.amount.gross;
    const gstAmount = round2((commission * GST_RATE_PERCENT) / 100);
    const totalBillAmount = round2(commission + gstAmount);

    const billData = {
      partnerId: req.partner._id,
      settlementId: settlement._id,
      billNumber,
      billDate,
      gstin,
      amount: { commission, gstRatePercent: GST_RATE_PERCENT, gstAmount, totalBillAmount, currency: settlement.amount.currency },
      file: {
        ...(await storeUploadedFile(req.file, `${req.partner._id}/bills`))
      },
      status: "submitted",
      verifiedBy: undefined,
      verifiedAt: undefined,
      rejectionReason: ""
    };

    // Resubmitting after a rejection replaces the prior bill (unique index
    // on settlementId) rather than erroring or piling up duplicates.
    const bill = existing
      ? await PartnerSettlementBill.findOneAndUpdate({ _id: existing._id }, { $set: billData }, { returnDocument: "after" })
      : await PartnerSettlementBill.create(billData);

    await recordSettlementHistory(settlement, {
      action: "bill_submitted",
      amount: { net: 0, gst: gstAmount, total: totalBillAmount, currency: settlement.amount.currency },
      meta: { billNumber, gstin },
      byPartnerUser: req.partnerUser._id,
      req
    });

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      // "document_uploaded" — the existing PartnerActivity.activityType enum
      // (a model, can't be extended) has no bill-specific value; this is the
      // closest accurate fit and is what document uploads elsewhere use too.
      activityType: "document_uploaded",
      entityType: "PartnerSettlement",
      entityId: settlement._id,
      description: `${req.partnerUser.name} submitted a bill (${billNumber}) for settlement ${settlement.settlementNumber}.`,
      req
    });

    await notifyAdmins({
      type: "bill_submitted",
      title: existing ? "Bill resubmitted for review" : "Bill to verify",
      message: `${partnerLabel(req.partner)} ${existing ? "re-uploaded" : "uploaded"} a bill for settlement ${settlement.settlementNumber}. Payout waits on this bill being verified.`,
      link: "/admin/settlements",
      audienceRoles: ["finance"],
      partnerId: req.partner._id,
      entityType: "PartnerSettlement",
      entityId: settlement._id
    });

    return res.status(201).json({ success: true, message: "Bill submitted — awaiting verification.", data: bill });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(400).json({ success: false, message: "A bill already exists for this settlement." });
    }
    console.error("submitBill error:", error);
    return res.status(error.statusCode || 500).json({ success: false, message: error.statusCode === 400 ? error.message : "Something went wrong submitting the bill." });
  }
};

const getBillForSettlement = async (req, res) => {
  const settlement = await PartnerSettlement.findOne({ _id: req.params.id, partnerId: req.partner._id });
  if (!settlement) {
    return res.status(404).json({ success: false, message: "Settlement not found." });
  }

  const bill = await PartnerSettlementBill.findOne({ settlementId: settlement._id });
  return res.json({ success: true, data: bill || null });
};

const downloadBill = async (req, res) => {
  try {
    const settlement = await PartnerSettlement.findOne({ _id: req.params.id, partnerId: req.partner._id });
    if (!settlement) return res.status(404).json({ success: false, message: "Settlement not found." });
    const bill = await PartnerSettlementBill.findOne({ settlementId: settlement._id });
    if (!bill || !await require("../utils/fileStorage").sendStoredFile(res, bill.file)) return res.status(404).json({ success: false, message: "Bill file not found." });
  } catch {
    return res.status(500).json({ success: false, message: "Could not download the bill. Please try again." });
  }
};
module.exports = { submitBill, getBillForSettlement, downloadBill };
