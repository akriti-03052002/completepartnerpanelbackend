const { Partner, PartnerCommission, InfluencerContentSubmission } = require("../models/Index");
const { settleApprovedCommission } = require("./autoSettlement");

const PLATFORM_LABEL = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };

/**
 * Turns an approved post/reel into a payment on the earnings ledger
 * (PartnerCommission), already approved — the admin approved it along with
 * the content — and puts it straight into a ready-to-pay settlement (see
 * autoSettlement.js). Settlements are built only from these ledger rows,
 * never from submissions.
 *
 * Idempotent per submission (unique submissionId): calling it again returns
 * the existing row instead of paying twice.
 */
const recordContentPayment = async (submission, { accountLabel, updateStats = true, byUserId, req } = {}) => {
  const existing = await PartnerCommission.findOne({ submissionId: submission._id });
  if (existing) return existing;

  const amount = Number(submission.payment?.amount || 0);
  if (!(amount > 0)) return null;

  const platform = PLATFORM_LABEL[submission.platform] || submission.platform;
  const commission = await PartnerCommission.create({
    partnerId: submission.partnerId,
    submissionId: submission._id,
    description: `${platform} ${submission.contentType}${accountLabel ? ` · ${accountLabel}` : ""}`,
    transaction: { currency: submission.payment.currency || "INR" },
    calculation: {
      commissionType: "fixed_per_deal",
      fixedAmount: amount,
      grossCommission: amount,
      deductions: 0,
      netCommission: amount
    },
    settlement: { status: "approved", eligibleAt: submission.reviewedAt || new Date() }
  });

  await InfluencerContentSubmission.updateOne({ _id: submission._id }, { $set: { "payment.commissionId": commission._id } });

  // Earned and owed until a settlement pays it out (see
  // settlementPayoutFulfillment, which moves it from pending to paid).
  if (updateStats) {
    await Partner.updateOne(
      { _id: submission.partnerId },
      { $inc: { "stats.totalCommission": amount, "stats.approvedCommission": amount, "stats.pendingCommission": amount } }
    );
  }

  // Never allowed to undo the approval itself: if the settlement can't be
  // opened now, the earning stays approved and is picked up at next start.
  try {
    await settleApprovedCommission(commission, { byUserId, req });
  } catch (error) {
    console.error("recordContentPayment: automatic settlement failed:", error.message);
  }

  return commission;
};

module.exports = { recordContentPayment };
