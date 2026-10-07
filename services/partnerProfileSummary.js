const { PartnerReferral, PartnerCommission, InfluencerContentSubmission, Customer, Invoice } = require("../models/Index");
const { getActiveCommissionAssignment } = require("../utils/partnerCommissionResolver");
const ResellerCustomer = require("../models/ResellerCustomer");
const ResellerInvoice = require("../models/ResellerInvoice");
const ResellerInventory = require("../models/ResellerInventory");
const Pricing = require("../models/ResellerPricingPlan");
const Billing = require("../models/ResellerBillingConfig");
const Order = require("../models/ScreenLicensePurchaseOrder");
const Payment = require("../models/CustomerPayment");
const group = async (model, match, field, value) => Object.fromEntries((await model.aggregate([
  { $match: match }, { $group: { _id: "$" + field, count: { $sum: 1 }, amount: { $sum: value ? "$" + value : 0 } } }
])).map((row) => [row._id, { count: row.count, amount: row.amount }]));
module.exports = async (partner) => {
  const filter = { partnerId: partner._id };
  const earnings = partner.partnerType === "reseller" ? {} : await group(PartnerCommission, filter, "settlement.status", "calculation.netCommission");
  const result = { earnings };
  if (partner.partnerType === "affiliate") {
    result.leads = await group(PartnerReferral, filter, "status", "closure.dealValue");
  } else if (partner.partnerType === "influencer") {
    result.posts = await group(InfluencerContentSubmission, filter, "status");
    result.platforms = await group(InfluencerContentSubmission, filter, "platform");
  } else if (partner.partnerType === "vendor") {
    const [customers, payments, assignment, pendingCommissionPayments, recentCustomers] = await Promise.all([
      group(Customer, filter, "subscription.status", "subscription.screenCount"),
      group(Invoice, filter, "status", "amount"), getActiveCommissionAssignment(partner._id),
      Payment.countDocuments({ ...filter, status: "paid", commissionGenerated: { $ne: true } }),
      Customer.find(filter).sort({ createdAt: -1 }).limit(10).select("companyName subscription.status subscription.screenCount").lean()
    ]);
    Object.assign(result, { customers, payments, assignment, pendingCommissionPayments, recentCustomers });
  } else if (partner.partnerType === "reseller") {
    const [customers, invoices, inventory, orders, pricing, billing, recentCustomers] = await Promise.all([
      group(ResellerCustomer, filter, "status"), group(ResellerInvoice, filter, "paymentStatus", "total"),
      ResellerInventory.findOne(filter).lean(), group(Order, filter, "orderStatus"),
      Pricing.findOne(filter).select("_id").lean(), Billing.findOne(filter).select("prepayment.status").lean(),
      ResellerCustomer.find(filter).sort({ createdAt: -1 }).limit(10).select("businessDetails.companyName status").lean()
    ]);
    Object.assign(result, { customers, invoices, inventory, orders, pricingConfigured: !!pricing, billingConfigured: !!billing, prepaymentStatus: billing?.prepayment?.status, recentCustomers });
  }
  return result;
};
