const crypto = require("crypto");

const randomSegment = (length) =>
  crypto.randomBytes(length).toString("hex").toUpperCase().slice(0, length);

// A database counter reserves codes across concurrent API instances.
// Keep old partner codes valid; only newly generated codes use four digits.
const generatePartnerCode = async () => {
  const Sequence = require("../models/CodeSequence");
  const Partner = require("../models/Partner");
  while (true) {
    let sequence;
    try {
      sequence = await Sequence.findOneAndUpdate(
        { _id: "partner", value: { $lt: 9999 } },
        [{ $set: { value: { $add: [{ $ifNull: ["$value", 999] }, 1] } } }],
        { upsert: true, returnDocument: "after", updatePipeline: true }
      );
    } catch (error) {
      if (error.code !== 11000) throw error;
      const current = await Sequence.findById("partner").lean();
      if (current?.value >= 9999) {
        const exhausted = new Error("All four-digit partner codes are in use. Contact support.");
        exhausted.statusCode = 503;
        throw exhausted;
      }
      continue;
    }
    const code = String(sequence.value);
    if (!await Partner.exists({ partnerCode: code })) return code;
  }
};

// Excludes visually ambiguous characters (0/O, 1/I) since partners will
// be reading these out loud / typing them in manually.
const REFERRAL_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REFERRAL_CODE_LENGTH = 4;

const generateReferralCode = () => {
  let code = "";
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += REFERRAL_CODE_CHARS[crypto.randomInt(REFERRAL_CODE_CHARS.length)];
  }
  return code;
};

const generateSettlementNumber = () => "STL-" + Date.now().toString().slice(-8) + "-" + randomSegment(3);

// Vendor partner referral code, generated once the partner is admin-verified
// (see adminPartnerController.updatePartnerStatus). Numeric per spec, so it's
// easy for a customer to type in on a signup form.
const generateNumericReferralCode = () => String(crypto.randomInt(1000, 10000));

module.exports = {
  generatePartnerCode,
  generateReferralCode,
  generateNumericReferralCode,
  generateSettlementNumber
};
