// Stable fixture identity: changing a display code must not lose the demo record.
const DEMO_ACCOUNTS = [
  { partnerType: "vendor", email: "vendor.scenario@spotx.demo" },
  { partnerType: "reseller", email: "reseller.scenario@spotx.demo" },
  { partnerType: "reseller", email: "demo.reseller@spotx.in" },
  { partnerType: "influencer", email: "ananya@influencer.demo" },
  { partnerType: "affiliate", email: "demo.document@example.com" }
];
const demoPartnerQuery = { $or: DEMO_ACCOUNTS.map(({ partnerType, email }) => ({ partnerType, "primaryContact.email": email })) };
const isDemoPartner = partner => DEMO_ACCOUNTS.some(account => account.partnerType === partner.partnerType && account.email === partner.primaryContact?.email);
module.exports = { demoPartnerQuery, isDemoPartner };
