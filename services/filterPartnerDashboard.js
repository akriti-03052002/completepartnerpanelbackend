// Dashboard access never grants permissions to its underlying data.
module.exports = (data, user) => {
  if (user.role === "owner") return data;
  const can = permission => (user.permissions || []).includes(permission);
  data.stats = { ...data.stats };
  if (!can("commissions:view")) {
    for (const key of ["totalCommission", "pendingCommission", "approvedCommission", "paidCommission"]) delete data.stats[key];
    delete data.businessOverview.earnings;
    delete data.typeStats.referralRewards;
    delete data.typeStats.contentEarnings;
    data.commissionTrend = [];
  }
  if (!can("referrals:view")) delete data.businessOverview.leads;
  if (!can("reseller:billing:view")) delete data.businessOverview.invoices;
  if (!can("reseller:license:purchase")) delete data.businessOverview.orders;
  if (!can("reseller:inventory:view")) delete data.businessOverview.inventory;
  if (!can("customers:view") && !can("reseller:customers:manage")) {
    delete data.businessOverview.customers;
    delete data.businessOverview.payments;
  }
  if (!can("notifications:view")) data.unreadNotifications = 0;
  // Activity descriptions may contain payment amounts or team details.
  data.recentActivity = [];
  return data;
};
