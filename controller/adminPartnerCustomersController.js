const { Partner, Customer } = require("../models/Index");
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
  return res.json({ success: true, data: rows.map((row) => ({ _id: row._id,
    name: row.companyName || row.businessDetails?.companyName, contact: row.contactName || row.contactDetails?.name,
    email: row.email || row.contactDetails?.email, status: row.subscription?.status || row.status,
    screens: row.subscription?.screenCount, createdAt: row.createdAt })), pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};
