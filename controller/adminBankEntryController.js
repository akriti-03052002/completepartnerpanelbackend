const { Partner, PartnerBankAccount } = require("../models/Index");
const { encrypt, maskAccountNumber, maskIfsc } = require("../utils/encryption");
const logActivity = require("../utils/logActivity");

module.exports = async (req, res) => {
  const { accountHolderName, bankName, accountNumber, ifsc, accountType } = req.body;
  if (![accountHolderName, bankName, accountNumber, ifsc].every(value => typeof value === "string" && value.trim()) || !["savings", "current", "other"].includes(accountType)) {
    return res.status(400).json({ success: false, message: "All bank fields are required." });
  }
  if (!/^\d{9,18}$/.test(accountNumber.trim()) || !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.trim().toUpperCase())) {
    return res.status(400).json({ success: false, message: "Enter a valid account number and IFSC." });
  }
  const partner = await Partner.findById(req.params.id);
  if (!partner) return res.status(404).json({ success: false, message: "Partner not found." });
  const values = {
    accountHolderName: accountHolderName.trim(), bankName: bankName.trim(), accountType,
    accountNumberEncrypted: encrypt(accountNumber.trim()), accountNumberLast4: maskAccountNumber(accountNumber.trim()),
    ifscEncrypted: encrypt(ifsc.trim().toUpperCase()), ifscMasked: maskIfsc(ifsc.trim().toUpperCase()),
    verification: { status: "pending" }, razorpayCheck: { paymentStatus: "not_initiated" }, commissionEligibility: "not_eligible"
  };
  let account = await PartnerBankAccount.findOne({ partnerId: partner._id });
  if (account?.verification?.status === "verified") return res.status(409).json({ success: false, message: "A verified account must use the existing bank change process." });
  if (account) {
    account = await PartnerBankAccount.findOneAndUpdate({ _id: account._id, "verification.status": { $ne: "verified" } }, { $set: values }, { new: true, runValidators: true });
    if (!account) return res.status(409).json({ success: false, message: "Bank account changed. Refresh and try again." });
  } else {
    account = await PartnerBankAccount.create({ partnerId: partner._id, ...values });
  }
  await logActivity({ partnerId: partner._id, performedByType: "spotx_user", performedByUserId: req.adminUser._id, activityType: "note", entityType: "PartnerBankAccount", entityId: account._id, description: "Admin entered bank details for review.", req });
  return res.json({ success: true, message: "Bank details saved for review." });
};
