const { Partner, PartnerNotification } = require("../models/Index");
const { generateNumericReferralCode } = require("../utils/generateCode");
const { isPartnerFullyVerified } = require("../utils/partnerVerification");
const { attachPartnerAgreement } = require("./generatePartnerAgreement");
const { refreshVendorScreenCount } = require("./tierAssignment");

/**
 * Generates and assigns a Vendor or Reseller customer-signup referral
 * code onto an already-loaded (not yet saved) Partner doc. Caller is
 * responsible for calling partner.save() afterward. Returns null if one
 * couldn't be generated (extremely unlikely — 9000 possible 4-digit codes)
 * or the partner already has one.
 */
const assignReferralCode = async (partner) => {
  if (partner.referral?.referralCode) return null;

  let referralCode = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = generateNumericReferralCode();
    // eslint-disable-next-line no-await-in-loop
    const taken = await Partner.exists({ "referral.referralCode": candidate });
    if (!taken) {
      referralCode = candidate;
      break;
    }
  }

  if (!referralCode) return null;

  const registrationPath = partner.partnerType === "reseller"
    ? "/reseller/customer/register"
    : "/customer/register";
  partner.referral = {
    referralCode,
    referralLink: `${process.env.CLIENT_URL || "http://localhost:5173"}${registrationPath}?ref=${referralCode}`
  };

  return referralCode;
};

/**
 * Called after a KYC document or the bank account gets verified. If the
 * partner is now fully verified — the required documents FOR THEIR TYPE
 * (see partnerVerification.js; business types need GST/MSME, individual
 * types like Affiliate/Influencer/Referral don't) plus a verified bank
 * account — and hasn't been activated yet, this activates them
 * automatically. No separate manual "set active" admin step required,
 * since the whole point is that verification IS the gate. Applies to
 * every partner type; Vendors and Resellers additionally get a customer
 * referral code for their respective registration flows.
 */
const autoActivatePartnerIfVerified = async (partnerId, adminUserId) => {
  const partner = await Partner.findById(partnerId);

  if (!partner || partner.status === "active") return null;

  const fullyVerified = await isPartnerFullyVerified(partnerId, partner.partnerType);
  if (!fullyVerified) return null;

  let referralCode = null;

  if (["vendor", "reseller"].includes(partner.partnerType) && !partner.referral?.referralCode) {
    referralCode = await assignReferralCode(partner);
    if (!referralCode) return null; // couldn't mint one — don't half-activate
  }

  partner.status = "active";
  partner.verification.overallStatus = "verified";
  partner.verification.verifiedBy = adminUserId;
  partner.verification.verifiedAt = new Date();
  await partner.save();

  await refreshVendorScreenCount(partner);

  await attachPartnerAgreement(partner, adminUserId);

  await PartnerNotification.create({
    partnerId: partner._id,
    type: referralCode ? "referral_code_generated" : "account_verified",
    title: "Your account is fully verified",
    message: referralCode
      ? `Your documents and bank account are verified — you're now an active partner. Your customer referral code is ${referralCode}.`
      : "Your documents and bank account are verified — you're now an active partner.",
    entity: { type: "Partner", entityId: partner._id }
  });

  return { referralCode };
};

module.exports = { assignReferralCode, autoActivatePartnerIfVerified };
