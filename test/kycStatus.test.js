const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeKycStatus } = require("../utils/partnerVerification");
const doc = (documentType, status, createdAt) => ({ documentType, verification: { status }, createdAt: new Date(createdAt) });
test("KYC follows newest upload through missing, waiting, rejected and approved states", () => {
  assert.equal(computeKycStatus([], "affiliate"), "not_submitted");
  const cheque = doc("cancelled_cheque", "verified", 1);
  assert.equal(computeKycStatus([cheque], "affiliate"), "not_submitted");
  const rejected = doc("pan_card", "rejected", 1);
  assert.equal(computeKycStatus([cheque, rejected], "affiliate"), "rejected");
  const replacement = doc("pan_card", "pending", 2);
  assert.equal(computeKycStatus([cheque, rejected, replacement], "affiliate"), "pending");
  replacement.verification.status = "verified";
  assert.equal(computeKycStatus([cheque, rejected, replacement], "affiliate"), "verified");
  assert.equal(computeKycStatus([cheque, replacement], "vendor"), "not_submitted");
});
test("older approvals cannot hide a newer rejected upload", () => {
  assert.equal(computeKycStatus([doc("pan_card", "verified", 1), doc("pan_card", "rejected", 2), doc("cancelled_cheque", "verified", 1)], "influencer"), "rejected");
});
