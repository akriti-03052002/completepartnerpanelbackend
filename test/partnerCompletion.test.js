const assert = require("node:assert/strict");
const { test } = require("node:test");
const completion = require("../utils/partnerCompletion");
const partner = { partnerType: "vendor", legalEntity: { businessName: "Studio" }, primaryContact: { name: "Jane", email: "jane@example.com", phone: "+919876543210" }, address: { country: "India", state: "Delhi", city: "Delhi", addressLine1: "Main Road", pincode: "110001" } };
const doc = (type, status = "submitted", date = 1) => ({ documentType: type, file: { objectKey: "stored-file" }, verification: { status }, createdAt: new Date(date) });
const bank = { accountHolderName: "Jane", bankName: "Bank", accountNumberLast4: "1234", verification: { status: "submitted" } };
test("profile progress counts filled details and whitespace remains missing", () => {
  assert.equal(completion(partner).profile.percent, 100);
  const result = completion({ ...partner, legalEntity: { businessName: " " }, address: {} });
  assert.equal(result.profile.completed, 3);
  assert.equal(result.profile.percent, 33);
  assert.ok(result.profile.missing.includes("Business / creator name"));
});
test("vendor combines four distinct required documents and one bank item", () => {
  const docs = [doc("pan_card"), doc("pan_card"), doc("other", "verified")];
  const result = completion(partner, docs, bank).documentsAndBank;
  assert.deepEqual(result, { completed: 2, total: 5, percent: 40, verified: 0 });
});
test("individual roles exclude optional documents and distinguish submitted from approved", () => {
  const p = { ...partner, partnerType: "influencer" };
  const result = completion(p, [doc("pan_card", "verified"), doc("cancelled_cheque"), doc("gst_certificate")], bank).documentsAndBank;
  assert.deepEqual(result, { completed: 3, total: 3, percent: 100, verified: 1 });
});
test("rejected or missing uploads do not count and newer replacements take precedence", () => {
  const result = completion(partner, [doc("pan_card", "verified", 1), doc("pan_card", "rejected", 2), { documentType: "gst_certificate", verification: { status: "verified" } }], { ...bank, verification: { status: "rejected" } }).documentsAndBank;
  assert.equal(result.percent, 0);
  assert.equal(result.verified, 0);
});
