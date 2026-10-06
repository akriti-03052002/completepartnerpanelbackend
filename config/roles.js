/**
 * Permission catalogue for PartnerUser roles.
 * "owner" always bypasses permission checks (see requirePermission middleware).
 */

const ALL_PARTNER_PERMISSIONS = [
  "dashboard:view",

  "team:view",
  "team:manage",

  "profile:view",
  "profile:update",

  "documents:view",
  "documents:upload",

  "bank:view",
  "bank:manage",

  "referrals:view",
  "referrals:create",

  "opportunities:view",
  "opportunities:create",

  "customers:view",
  "customers:manage",

  "commissions:view",

  "settlements:view",

  "notifications:view",

  // Reseller-only — meaningless for every other partnerType, but not
  // gated by OWNER_ONLY_PERMISSIONS (KYC/bank stay the only owner-only
  // gate; these follow the same view/manage split as customers:*).
  "reseller:inventory:view",
  "reseller:license:purchase",
  "reseller:customers:manage",
  "reseller:allocation:manage",
  "reseller:billing:view",
  "reseller:billing:pay"
];

/*
  documents:* and bank:* are deliberately owner-only (KYC + payout
  account are the most sensitive data on a partner account). No other
  role gets them, no matter what's passed in from the invite form.
*/
const OWNER_ONLY_PERMISSIONS = ["documents:view", "documents:upload", "bank:view", "bank:manage"];

const ROLE_PERMISSIONS = {
  owner: [...ALL_PARTNER_PERMISSIONS],

  admin: [
    "dashboard:view",
    "team:view",
    "team:manage",
    "profile:view",
    "profile:update",
    "referrals:view",
    "referrals:create",
    "opportunities:view",
    "opportunities:create",
    "customers:view",
    "customers:manage",
    "commissions:view",
    "settlements:view",
    "notifications:view",
    "reseller:inventory:view",
    "reseller:license:purchase",
    "reseller:customers:manage",
    "reseller:allocation:manage",
    "reseller:billing:view",
    "reseller:billing:pay"
  ],

  sales: [
    "dashboard:view",
    "profile:view",
    "referrals:view",
    "referrals:create",
    "opportunities:view",
    "opportunities:create",
    "customers:view",
    "customers:manage",
    "notifications:view",
    "reseller:inventory:view",
    "reseller:customers:manage",
    "reseller:allocation:manage"
  ],

  finance: [
    "dashboard:view",
    "profile:view",
    "customers:view",
    "commissions:view",
    "settlements:view",
    "notifications:view",
    "reseller:inventory:view",
    "reseller:billing:view",
    "reseller:billing:pay"
  ],

  viewer: [
    "dashboard:view",
    "profile:view",
    "referrals:view",
    "opportunities:view",
    "reseller:inventory:view",
    "reseller:billing:view",
    "customers:view",
    "commissions:view",
    "settlements:view",
    "notifications:view"
  ]
};

const ADMIN_ROLES = ["super_admin", "kyc_reviewer", "finance"];

module.exports = {
  ALL_PARTNER_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  ROLE_PERMISSIONS,
  ADMIN_ROLES
};
