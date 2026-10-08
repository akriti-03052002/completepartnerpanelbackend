const { Partner, Customer, Screen } = require("../models/Index");
const CustomerAllocation = require("../models/CustomerAllocation");
const ResellerCustomer = require("../models/ResellerCustomer");
const pagination = require("../utils/pagination");
module.exports = async (req, res) => {
  const partner = await Partner.findById(req.params.id);
  if (!partner) return res.status(404).json({ success: false, message: "Partner not found." });
  if (!["vendor", "reseller"].includes(partner.partnerType)) return res.status(400).json({ success: false, message: "This partner type does not have customers." });
  const model = partner.partnerType === "vendor" ? Customer : ResellerCustomer;
  const filter = { partnerId: partner._id };
  const { page, limit, skip } = pagination(req.query);
  const [rows, total] = await Promise.all([
    model.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit)
      .select(partner.partnerType === "vendor" ? "companyName contactName email subscription.status subscription.screenCount createdAt" : "businessDetails.companyName contactDetails.name contactDetails.email status createdAt").lean(),
    model.countDocuments(filter)
  ]);
  const customerIds = rows.map(row => row._id);
  const [registered, allocations] = await Promise.all([
    Screen.aggregate([
      { $match: { customerId: { $in: customerIds } } },
      { $group: { _id: "$customerId", count: { $sum: 1 } } }
    ]),
    partner.partnerType === "reseller" ? CustomerAllocation.aggregate([
      { $match: { partnerId: partner._id, customerId: { $in: customerIds }, status: { $ne: "cancelled" } } },
      { $group: { _id: "$customerId", count: { $sum: "$allocatedLicenses" } } }
    ]) : Promise.resolve([])
  ]);
  const registeredCounts = new Map(registered.map(row => [String(row._id), row.count]));
  const subscribedCounts = new Map(allocations.map(row => [String(row._id), row.count]));
  return res.json({ success: true, data: rows.map((row) => ({ _id: row._id,
    name: row.companyName || row.businessDetails?.companyName, contact: row.contactName || row.contactDetails?.name,
    email: row.email || row.contactDetails?.email, status: row.subscription?.status || row.status,
    screens: row.subscription?.screenCount,
    registeredScreens: registeredCounts.get(String(row._id)) || 0,
    subscribedScreens: partner.partnerType === "vendor" ? Number(row.subscription?.screenCount) || 0 : subscribedCounts.get(String(row._id)) || 0,
    createdAt: row.createdAt })), partnerType: partner.partnerType, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};
