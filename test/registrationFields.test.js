const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const { validateRegistration, registrationFields } = require("../validations/registrationFields");
const partner = { partnerType: "vendor", contactName: "Akriti Joshi", email: "name@example.com", phone: "+91 9876543210", password: "testing-password" };
test("names reject numbers and allow real names in multiple languages", () => {
  for (const contactName of ["Akriti123", "123", "<script>", " ", "A@B"]) assert.ok(validateRegistration({ ...partner, contactName }, { partner: true }).contactName);
  for (const contactName of ["Akriti Joshi", "Anne-Marie", "O’Connor", "José", "अकृति जोशी", "李明"]) assert.deepEqual(validateRegistration({ ...partner, contactName }, { partner: true }), {});
});
test("phone, email, password, role and postal fields have independent checks", () => {
  for (const [field, value] of [["phone", "123"], ["phone", "+91 ABCDE12345"], ["phone", "+1234567890123456"], ["email", "bad"], ["partnerType", "admin"], ["password", "short"], ["password", "a".repeat(129)]]) assert.ok(validateRegistration({ ...partner, [field]: value }, { partner: true })[field]);
  assert.ok(validateRegistration({ ...partner, country: "India", pincode: "12AB56" }, { partner: true }).pincode);
  assert.deepEqual(validateRegistration({ ...partner, country: "India", pincode: "110001" }, { partner: true }), {});
  assert.deepEqual(validateRegistration({ ...partner, country: "Canada", pincode: "K1A 0B1" }, { partner: true }), {});
});
test("company names allow digits and Google skips password but not identity fields", () => {
  const customer = { companyName: "Studio 24", contactName: "Jane Doe", email: "test@example.com", referralCode: "REF-123", phone: "+1 2025550123", password: "testing-password" };
  assert.deepEqual(validateRegistration(customer), {});
  assert.ok(validateRegistration({ ...customer, referralCode: "bad code!" }).referralCode);
  assert.deepEqual(validateRegistration({ ...partner, email: undefined, password: undefined }, { partner: true, google: true }), {});
  assert.ok(validateRegistration({ ...partner, contactName: "John2" }, { partner: true, google: true }).contactName);
});
test("backend returns field errors, trims allowed text and never trims passwords", async () => {
  const app = express();
  app.use(express.json());
  app.post("/register", registrationFields({ partner: true }), (req, res) => res.json(req.body));
  const bad = await request(app).post("/register").send({ ...partner, contactName: "John123" });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.contactName);
  const good = await request(app).post("/register").send({ ...partner, contactName: " Akriti Joshi ", password: " spaced password " });
  assert.equal(good.status, 200);
  assert.equal(good.body.contactName, "Akriti Joshi");
  assert.equal(good.body.password, " spaced password ");
});
