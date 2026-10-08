const { Partner, Customer, PartnerReferral, PartnerDocument, PartnerBankAccount, PartnerCommission, PartnerSettlement } = require("../models/Index");
const ResellerInventory = require("../models/ResellerInventory");
const ResellerInvoice = require("../models/ResellerInvoice");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");
const ResellerCustomer = require("../models/ResellerCustomer");
const ScreenLicensePurchaseOrder = require("../models/ScreenLicensePurchaseOrder");
const InfluencerContentSubmission = require("../models/InfluencerContentSubmission");
const { getRequiredDocumentTypes } = require("../utils/partnerVerification");

/* ============================================================
   ADMIN — CROSS-CUTTING KPI AGGREGATION
   Read-only rollups for the admin dashboard, sourced entirely
   from existing collections — no new stat fields.
============================================================ */

const groupCounts = (rows) => rows.reduce((acc, r) => ({ ...acc, [r._id || "unknown"]: r.count }), {});

const getKpis = async (req, res) => {
  const [
    totalPartners, activePartners, partnersByType, partnersByStatus,
    totalCustomers, customersBySubStatus,
    totalLeads, leadsByStatus,
    documentsByStatus, bankAccountsByStatus, commissionsByStatus, settlementsByStatus,
    commissionTotals, paidPayouts
  ] = await Promise.all([
    Partner.countDocuments(),
    Partner.countDocuments({ status: "active" }),
    Partner.aggregate([{ $group: { _id: "$partnerType", count: { $sum: 1 } } }]),
    Partner.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    Customer.countDocuments(),
    Customer.aggregate([{ $group: { _id: "$subscription.status", count: { $sum: 1 } } }]),
    PartnerReferral.countDocuments(),
    PartnerReferral.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    PartnerDocument.aggregate([{ $group: { _id: "$verification.status", count: { $sum: 1 } } }]),
    PartnerBankAccount.aggregate([{ $group: { _id: "$verification.status", count: { $sum: 1 } } }]),
    PartnerCommission.aggregate([{ $group: { _id: "$settlement.status", count: { $sum: 1 } } }]),
    PartnerSettlement.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    PartnerCommission.aggregate([{ $group: { _id: null, total: { $sum: "$calculation.netCommission" } } }]),
    PartnerSettlement.aggregate([{ $match: { status: "paid" } }, { $group: { _id: null, total: { $sum: "$amount.net" } } }])
  ]);

  return res.json({
    success: true,
    data: {
      totalPartners,
      activePartners,
      partnersByType: groupCounts(partnersByType),
      partnersByStatus: groupCounts(partnersByStatus),
      totalCustomers,
      customersBySubscriptionStatus: groupCounts(customersBySubStatus),
      totalLeads,
      leadsByStatus: groupCounts(leadsByStatus),
      documentsByStatus: groupCounts(documentsByStatus),
      bankAccountsByStatus: groupCounts(bankAccountsByStatus),
      commissionsByStatus: groupCounts(commissionsByStatus),
      settlementsByStatus: groupCounts(settlementsByStatus),
      totalCommissionGenerated: commissionTotals[0]?.total || 0,
      totalPayoutsPaid: paidPayouts[0]?.total || 0
    }
  });
};

/* ============================================================
   ADMIN DASHBOARD
   One read-only summary, computed live from the records
   themselves — nothing here is stored or hardcoded:

   - money coming IN, by where it comes from
       Reseller  -> license invoices and prepayments they have paid
       Vendor    -> what their customers have paid for subscriptions
                    (before GST)
       Affiliate -> the value of the deals won from their leads
   - money going OUT, by who it is paid to
       Vendor commission, Affiliate referral rewards, Influencer
       content payments (a Reseller earns nothing)
   - partner counts by type, status, and what is still pending
============================================================ */

const sumOf = (rows) => rows[0]?.total || 0;

const getDashboard = async (req, res) => {
  try {
    const partners = await Partner.find({}, "partnerType status verification.overallStatus").lean();
    const idsByType = { vendor: [], affiliate: [], influencer: [], reseller: [] };
    for (const partner of partners) {
      if (idsByType[partner.partnerType]) idsByType[partner.partnerType].push(partner._id);
    }

    const [
      resellerInventory, resellerInvoicesPaid, resellerInvoicesDue, resellerPrepayments,
      vendorCustomers, vendorActiveCustomers, vendorPaidScreens, vendorPayments,
      leadsByStatus, wonDeals,
      commissionsByPartner,
      verifiedDocs, bankAccounts
    ] = await Promise.all([
      ResellerInventory.aggregate([{ $group: {
        _id: null,
        purchased: { $sum: "$totalPurchasedLicenses" },
        allocated: { $sum: "$totalAllocatedLicenses" },
        active: { $sum: "$totalActiveScreens" }
      } }]),
      ResellerInvoice.aggregate([{ $match: { paymentStatus: "paid" } }, { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }]),
      ResellerInvoice.aggregate([{ $match: { paymentStatus: { $ne: "paid" } } }, { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }]),
      ResellerBillingConfig.aggregate([{ $match: { "prepayment.status": "done" } }, { $group: { _id: null, total: { $sum: "$prepayment.amount" } } }]),

      Customer.countDocuments(),
      Customer.countDocuments({ "subscription.status": "active" }),
      Customer.aggregate([{ $match: { "subscription.status": "active" } }, { $group: { _id: null, total: { $sum: "$subscription.screenCount" } } }]),
      // What vendors' customers have paid for subscriptions (before GST).
      // Every confirmed customer payment — through the gateway or recorded
      // by an admin — writes one commission row carrying the amount paid,
      // so this is the one place both kinds are counted, old and new.
      PartnerCommission.aggregate([
        { $match: { partnerId: { $in: idsByType.vendor }, customerId: { $exists: true, $ne: null }, "settlement.status": { $ne: "cancelled" } } },
        { $group: { _id: null, total: { $sum: "$transaction.revenue" }, count: { $sum: 1 } } }
      ]),

      PartnerReferral.aggregate([{ $match: { partnerId: { $in: idsByType.affiliate } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
      PartnerReferral.aggregate([
        { $match: { partnerId: { $in: idsByType.affiliate }, status: "won" } },
        { $group: { _id: null, total: { $sum: "$closure.dealValue" }, count: { $sum: 1 } } }
      ]),

      // Every earning that has not been reversed, by partner and by whether
      // it has actually been paid out yet.
      PartnerCommission.aggregate([
        { $match: { "settlement.status": { $ne: "cancelled" } } },
        { $group: {
          _id: { partnerId: "$partnerId", paid: { $eq: ["$settlement.status", "settled"] } },
          total: { $sum: "$calculation.netCommission" },
          count: { $sum: 1 }
        } }
      ]),

      PartnerDocument.aggregate([
        { $match: { "verification.status": "verified" } },
        { $group: { _id: "$partnerId", types: { $addToSet: "$documentType" } } }
      ]),
      PartnerBankAccount.find({}, "partnerId verification.status pendingChange.submittedAt").lean()
    ]);

    /* ---- money coming in ---- */
    const inventory = resellerInventory[0] || { purchased: 0, allocated: 0, active: 0 };
    const resellerRevenue = sumOf(resellerInvoicesPaid) + sumOf(resellerPrepayments);
    const vendorRevenue = sumOf(vendorPayments);
    const leadCounts = groupCounts(leadsByStatus);
    const totalLeads = Object.values(leadCounts).reduce((sum, n) => sum + n, 0);
    const affiliateRevenue = sumOf(wonDeals);

    /* ---- money going out ---- */
    const typeOfPartner = new Map(partners.map((partner) => [String(partner._id), partner.partnerType]));
    const payouts = {
      vendor: { total: 0, paid: 0, pending: 0, count: 0 },
      affiliate: { total: 0, paid: 0, pending: 0, count: 0 },
      influencer: { total: 0, paid: 0, pending: 0, count: 0 }
    };
    for (const row of commissionsByPartner) {
      const bucket = payouts[typeOfPartner.get(String(row._id.partnerId))];
      if (!bucket) continue;
      bucket.total += row.total;
      bucket.count += row.count;
      if (row._id.paid) bucket.paid += row.total;
      else bucket.pending += row.total;
    }
    const totalCommission = payouts.vendor.total + payouts.affiliate.total + payouts.influencer.total;
    const totalCommissionPaid = payouts.vendor.paid + payouts.affiliate.paid + payouts.influencer.paid;

    /* ---- partners ---- */
    const byType = { vendor: 0, affiliate: 0, influencer: 0, reseller: 0 };
    const byStatus = {};
    let verified = 0;
    const verifiedDocTypes = new Map(verifiedDocs.map((row) => [String(row._id), new Set(row.types)]));
    const bankStatus = new Map(bankAccounts.map((account) => [String(account.partnerId), account.verification?.status]));
    let kycPending = 0;
    let bankPending = 0;

    for (const partner of partners) {
      if (byType[partner.partnerType] !== undefined) byType[partner.partnerType] += 1;
      byStatus[partner.status] = (byStatus[partner.status] || 0) + 1;
      if (partner.verification?.overallStatus === "verified") verified += 1;

      // "Pending" = still owed by a partner SPOTX has not turned away: not
      // every document required for their type is verified yet / no
      // verified bank account yet.
      if (["rejected", "inactive"].includes(partner.status)) continue;
      const have = verifiedDocTypes.get(String(partner._id)) || new Set();
      if (!getRequiredDocumentTypes(partner.partnerType).every((type) => have.has(type))) kycPending += 1;
      if (bankStatus.get(String(partner._id)) !== "verified" || bankAccounts.some(account => String(account.partnerId) === String(partner._id) && account.pendingChange)) bankPending += 1;
    }

    return res.json({
      success: true,
      data: {
        generatedAt: new Date(),
        overview: {
          resellerRevenue,
          vendorRevenue,
          affiliateRevenue,
          totalRevenue: resellerRevenue + vendorRevenue + affiliateRevenue,
          totalCommission,
          totalCommissionPaid,
          totalCommissionPending: totalCommission - totalCommissionPaid
        },
        reseller: {
          licensesPurchased: inventory.purchased,
          licensesAllocated: inventory.allocated,
          licensesActive: inventory.active,
          totalAmount: resellerRevenue,
          invoicesPaid: resellerInvoicesPaid[0]?.count || 0,
          amountDue: sumOf(resellerInvoicesDue),
          prepayments: sumOf(resellerPrepayments)
        },
        vendor: {
          totalCustomers: vendorCustomers,
          activeCustomers: vendorActiveCustomers,
          paidScreens: sumOf(vendorPaidScreens),
          totalAmount: vendorRevenue,
          payments: vendorPayments[0]?.count || 0
        },
        affiliate: {
          totalLeads,
          wonDeals: wonDeals[0]?.count || 0,
          openLeads: (leadCounts.new || 0) + (leadCounts.contacted || 0),
          rejectedLeads: leadCounts.rejected || 0,
          totalAmount: affiliateRevenue
        },
        payouts,
        partners: {
          total: partners.length,
          byType,
          active: byStatus.active || 0,
          rejected: byStatus.rejected || 0,
          suspended: byStatus.suspended || 0,
          verified,
          kycPending,
          bankPending,
          byStatus
        }
      }
    });
  } catch (error) {
    console.error("getDashboard error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong loading the dashboard." });
  }
};

/* ============================================================
   PER-TYPE OVERVIEW
   The quick overview an admin sees when opening Influencer,
   Affiliate, Vendor or Reseller in the menu: that type's partners
   and what is waiting on SPOTX, plus the figures that matter for
   that type only. Computed live from the records.
============================================================ */

const getTypeOverview = async (req, res) => {
  try {
    const { partnerType } = req.params;
    if (!["influencer", "affiliate", "vendor", "reseller"].includes(partnerType)) {
      return res.status(404).json({ success: false, message: "Unknown partner type." });
    }

    const partners = await Partner.find({ partnerType }, "status verification.overallStatus partnerCode legalEntity.businessName primaryContact.name primaryContact.email createdAt socialAccounts.reviewStatus").sort({ createdAt: -1 }).lean();
    const ids = partners.map((partner) => partner._id);

    const [verifiedDocs, bankAccounts, earnings] = await Promise.all([
      PartnerDocument.aggregate([
        { $match: { partnerId: { $in: ids }, "verification.status": "verified" } },
        { $group: { _id: "$partnerId", types: { $addToSet: "$documentType" } } }
      ]),
      PartnerBankAccount.find({ partnerId: { $in: ids } }, "partnerId verification.status pendingChange.submittedAt").lean(),
      PartnerCommission.aggregate([
        { $match: { partnerId: { $in: ids }, "settlement.status": { $ne: "cancelled" } } },
        { $group: { _id: "$settlement.status", total: { $sum: "$calculation.netCommission" }, count: { $sum: 1 } } }
      ])
    ]);

    const byStatus = {};
    let verified = 0;
    let kycPending = 0;
    let bankPending = 0;
    const docTypes = new Map(verifiedDocs.map((row) => [String(row._id), new Set(row.types)]));
    const bankStatus = new Map(bankAccounts.map((account) => [String(account.partnerId), account.verification?.status]));
    const required = getRequiredDocumentTypes(partnerType);
    for (const partner of partners) {
      byStatus[partner.status] = (byStatus[partner.status] || 0) + 1;
      if (partner.verification?.overallStatus === "verified") verified += 1;
      if (["rejected", "inactive"].includes(partner.status)) continue;
      const have = docTypes.get(String(partner._id)) || new Set();
      if (!required.every((type) => have.has(type))) kycPending += 1;
      if (bankStatus.get(String(partner._id)) !== "verified" || bankAccounts.some(account => String(account.partnerId) === String(partner._id) && account.pendingChange)) bankPending += 1;
    }

    const earned = { total: 0, paid: 0, pending: 0, awaitingApproval: 0, count: 0 };
    for (const row of earnings) {
      earned.total += row.total;
      earned.count += row.count;
      if (row._id === "settled") earned.paid += row.total;
      else earned.pending += row.total;
      if (row._id === "pending") earned.awaitingApproval += row.count;
    }

    let details = {};

    if (partnerType === "influencer") {
      const [posts] = await Promise.all([
        InfluencerContentSubmission.aggregate([{ $match: { partnerId: { $in: ids } } }, { $group: { _id: "$status", count: { $sum: 1 } } }])
      ]);
      const postCounts = groupCounts(posts);
      const accounts = partners.flatMap((partner) => partner.socialAccounts || []);
      details = {
        postsPending: postCounts.pending || 0,
        postsApproved: postCounts.approved || 0,
        postsRejected: postCounts.rejected || 0,
        accountsPending: accounts.filter((account) => account.reviewStatus === "pending").length,
        accountsVerified: accounts.filter((account) => account.reviewStatus === "verified").length
      };
    }

    if (partnerType === "affiliate") {
      const [leads, won] = await Promise.all([
        PartnerReferral.aggregate([{ $match: { partnerId: { $in: ids } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
        PartnerReferral.aggregate([{ $match: { partnerId: { $in: ids }, status: "won" } }, { $group: { _id: null, total: { $sum: "$closure.dealValue" } } }])
      ]);
      const leadCounts = groupCounts(leads);
      details = {
        totalLeads: Object.values(leadCounts).reduce((sum, n) => sum + n, 0),
        newLeads: leadCounts.new || 0,
        contactedLeads: leadCounts.contacted || 0,
        wonDeals: leadCounts.won || 0,
        rejectedLeads: leadCounts.rejected || 0,
        wonValue: sumOf(won)
      };
    }

    if (partnerType === "vendor") {
      const [customers, paidScreens, revenue] = await Promise.all([
        Customer.aggregate([{ $match: { partnerId: { $in: ids } } }, { $group: { _id: "$subscription.status", count: { $sum: 1 } } }]),
        Customer.aggregate([{ $match: { partnerId: { $in: ids }, "subscription.status": "active" } }, { $group: { _id: null, total: { $sum: "$subscription.screenCount" } } }]),
        PartnerCommission.aggregate([
          { $match: { partnerId: { $in: ids }, customerId: { $exists: true, $ne: null }, "settlement.status": { $ne: "cancelled" } } },
          { $group: { _id: null, total: { $sum: "$transaction.revenue" } } }
        ])
      ]);
      const customerCounts = groupCounts(customers);
      details = {
        totalCustomers: Object.values(customerCounts).reduce((sum, n) => sum + n, 0),
        activeCustomers: customerCounts.active || 0,
        trialCustomers: customerCounts.trial || 0,
        paidScreens: sumOf(paidScreens),
        revenue: sumOf(revenue)
      };
    }

    if (partnerType === "reseller") {
      const [inventory, paid, due, prepayments, pendingOrders, customers] = await Promise.all([
        ResellerInventory.aggregate([{ $match: { partnerId: { $in: ids } } }, { $group: {
          _id: null, purchased: { $sum: "$totalPurchasedLicenses" }, allocated: { $sum: "$totalAllocatedLicenses" }, active: { $sum: "$totalActiveScreens" }
        } }]),
        ResellerInvoice.aggregate([{ $match: { partnerId: { $in: ids }, paymentStatus: "paid" } }, { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }]),
        ResellerInvoice.aggregate([{ $match: { partnerId: { $in: ids }, paymentStatus: { $ne: "paid" } } }, { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }]),
        ResellerBillingConfig.aggregate([{ $match: { partnerId: { $in: ids }, "prepayment.status": "done" } }, { $group: { _id: null, total: { $sum: "$prepayment.amount" } } }]),
        ScreenLicensePurchaseOrder.countDocuments({ partnerId: { $in: ids }, orderStatus: "requested" }),
        ResellerCustomer.countDocuments({ partnerId: { $in: ids } })
      ]);
      const stock = inventory[0] || { purchased: 0, allocated: 0, active: 0 };
      details = {
        licensesPurchased: stock.purchased,
        licensesAllocated: stock.allocated,
        licensesActive: stock.active,
        customers,
        pendingLicenseRequests: pendingOrders,
        amountReceived: sumOf(paid) + sumOf(prepayments),
        amountDue: sumOf(due),
        invoicesDue: due[0]?.count || 0
      };
    }

    return res.json({
      success: true,
      data: {
        partnerType,
        generatedAt: new Date(),
        partners: {
          total: partners.length,
          active: byStatus.active || 0,
          pendingVerification: (byStatus.pending_verification || 0) + (byStatus.under_review || 0) + (byStatus.draft || 0),
          rejected: byStatus.rejected || 0,
          suspended: byStatus.suspended || 0,
          verified,
          kycPending,
          bankPending
        },
        // A Reseller pays SPOTX and earns nothing, so it has no earnings block.
        earnings: partnerType === "reseller" ? null : earned,
        details,
        recentPartners: partners.slice(0, 5).map((partner) => ({
          _id: partner._id,
          partnerCode: partner.partnerCode,
          name: partner.legalEntity?.businessName || partner.primaryContact?.name || "",
          email: partner.primaryContact?.email || "",
          status: partner.status,
          createdAt: partner.createdAt
        }))
      }
    });
  } catch (error) {
    console.error("getTypeOverview error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong loading the overview." });
  }
};

module.exports = { getKpis, getDashboard, getTypeOverview };
