const {
  Customer,
  InfluencerContentSubmission,
  PartnerActivity,
  PartnerCommission,
  PartnerNotification,
  PartnerDocument,
  PartnerBankAccount,
  PartnerReferral,
  PartnerTier
} = require("../models/Index");
const { getRequiredDocumentTypes, getDefaultMetricLabel, isProfileComplete } = require("../utils/partnerVerification");

/* ============================================================
   PARTNER DASHBOARD
============================================================ */

// Distinct from partner.verification.overallStatus (a single flag for the
// whole partner) — this breaks it down into the two things the partner
// actually needs to act on separately. Required doc types depend on the
// partner's own type (business types need GST/MSME; individual-oriented
// types like Affiliate/Influencer/Referral just need PAN + a cheque).
const computeKycStatus = (documents, partnerType) => {
  const requiredTypes = getRequiredDocumentTypes(partnerType);
  const required = documents.filter((d) => requiredTypes.includes(d.documentType));

  if (required.length === 0) return "not_submitted";
  if (required.some((d) => d.verification.status === "rejected")) return "rejected";

  const verifiedTypes = new Set(required.filter((d) => d.verification.status === "verified").map((d) => d.documentType));
  if (requiredTypes.every((type) => verifiedTypes.has(type))) return "verified";

  return "pending";
};

const computeBankStatus = (bankAccount) => {
  if (!bankAccount) return "not_submitted";
  return bankAccount.verification.status; // pending | verified | rejected
};

const getPartnerTypeStats = async (partner) => {
  if (partner.partnerType === "influencer") {
    const [contentStats] = await InfluencerContentSubmission.aggregate([
      { $match: { partnerId: partner._id } },
      {
        $group: {
          _id: null,
          totalSubmitted: { $sum: 1 },
          pendingReview: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
          approved: { $sum: { $cond: [{ $eq: ["$status", "approved"] }, 1, 0] } },
          contentEarnings: {
            $sum: {
              $cond: [{ $eq: ["$payment.status", "approved"] }, "$payment.amount", 0]
            }
          }
        }
      }
    ]);

    return {
      socialAccounts: partner.socialAccounts?.length || 0,
      totalSubmitted: contentStats?.totalSubmitted || 0,
      pendingReview: contentStats?.pendingReview || 0,
      approved: contentStats?.approved || 0,
      contentEarnings: contentStats?.contentEarnings || 0
    };
  }

  if (partner.partnerType === "affiliate") {
    const [referralStats] = await PartnerReferral.aggregate([
      { $match: { partnerId: partner._id } },
      {
        $group: {
          _id: null,
          totalDeals: { $sum: 1 },
          inProgress: {
            $sum: {
              $cond: [
                { $in: ["$status", ["new", "contacted", "qualified", "demo_scheduled", "demo_completed", "proposal"]] },
                1,
                0
              ]
            }
          },
          wonDeals: { $sum: { $cond: [{ $eq: ["$status", "won"] }, 1, 0] } },
          referralRewards: { $sum: "$closure.commissionAmount" }
        }
      }
    ]);

    return {
      totalDeals: referralStats?.totalDeals || 0,
      inProgress: referralStats?.inProgress || 0,
      wonDeals: referralStats?.wonDeals || 0,
      referralRewards: referralStats?.referralRewards || 0
    };
  }

  if (partner.partnerType === "vendor") {
    const [totalCustomers, activeCustomers] = await Promise.all([
      Customer.countDocuments({ partnerId: partner._id }),
      Customer.countDocuments({ partnerId: partner._id, "subscription.status": "active" })
    ]);

    return { totalCustomers, activeCustomers };
  }

  return {};
};

const getDashboard = async (req, res) => {
  try {
    const partner = req.partner;

    const [recentActivity, unreadNotifications, commissionTrend, documents, bankAccount, tier, typeStats, businessOverview] = await Promise.all([
      PartnerActivity.find({ partnerId: partner._id }).sort({ createdAt: -1 }).limit(10),
      PartnerNotification.countDocuments({ partnerId: partner._id, read: false }),
      PartnerCommission.aggregate([
        { $match: { partnerId: partner._id, "settlement.status": { $ne: "cancelled" } } },
        {
          $group: {
            _id: { year: { $year: "$createdAt" }, month: { $month: "$createdAt" } },
            total: { $sum: "$calculation.netCommission" }
          }
        },
        { $sort: { "_id.year": -1, "_id.month": -1 } },
        { $limit: 12 },
        { $sort: { "_id.year": 1, "_id.month": 1 } }
      ]),
      PartnerDocument.find({ partnerId: partner._id }),
      PartnerBankAccount.findOne({ partnerId: partner._id }),
      partner.partnerType !== "vendor" && partner.program?.tierId ? PartnerTier.findById(partner.program.tierId) : null,
      getPartnerTypeStats(partner),
      require("../services/partnerProfileSummary")(partner)
    ]);

    const metricLabel = tier?.qualification?.metric?.label || getDefaultMetricLabel(partner.partnerType);
    const metricValue = partner.partnerType === "vendor"
      ? partner.stats.referredScreens
      : partner.partnerType === "affiliate"
        ? typeStats.totalDeals
        : partner.stats.totalLeads;

    const data = {
        stats: partner.stats,
        partnerType: partner.partnerType,
        typeStats,
        businessOverview: { earnings: businessOverview.earnings, leads: businessOverview.leads, posts: businessOverview.posts, platforms: businessOverview.platforms, customers: businessOverview.customers, payments: businessOverview.payments, inventory: businessOverview.inventory, invoices: businessOverview.invoices, orders: businessOverview.orders },
        metricLabel,
        metricValue,
        verificationStatus: partner.verification.overallStatus,
        partnerStatus: partner.status,
        partnerRejectionReason: partner.status === "rejected" ? partner.verification.rejectionReason : "",
        // Registration only collects name/email/phone/type — what's still
        // missing afterward depends on the partner type (see
        // isProfileComplete).
        profileComplete: isProfileComplete(partner),
        kycStatus: computeKycStatus(documents, partner.partnerType),
        bankStatus: computeBankStatus(bankAccount),
        unreadNotifications,
        recentActivity,
        commissionTrend: commissionTrend.map((row) => ({
          period: `${row._id.year}-${String(row._id.month).padStart(2, "0")}`,
          total: row.total
        }))
    };
    require("../services/filterPartnerDashboard")(data, req.partnerUser);
    return res.json({ success: true, data });
  } catch (error) {
    console.error("getDashboard error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong loading the dashboard." });
  }
};

module.exports = { getDashboard };
