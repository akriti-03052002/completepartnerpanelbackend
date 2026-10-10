const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const express = require("express");
const request = require("supertest");
const { OAuth2Client } = require("google-auth-library");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "google-test-secret";
process.env.CUSTOMER_JWT_SECRET = "google-portal-secret";
process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
process.env.CLIENT_URL = "http://localhost:5173";
require("../utils/mailer").sendMail = async () => { throw new Error("Google registrations must not send activation email"); };

// Stub Google's remote verification boundary; real controllers and database run below.
const identities = new Map();
const originalVerify = OAuth2Client.prototype.verifyIdToken;
OAuth2Client.prototype.verifyIdToken = async ({ idToken, audience }) => {
  assert.equal(audience, process.env.GOOGLE_CLIENT_ID);
  if (!identities.has(idToken)) throw new Error("Invalid signature");
  return { getPayload: () => identities.get(idToken) };
};
const app = express();
app.use(express.json());
app.use("/api/partner/auth", require("../router/partnerAuthRoutes"));
app.use("/api/public/customers", require("../router/customerPublicRoutes"));
app.use("/api/public/reseller-customers", require("../router/publicResellerCustomerRoutes"));
const Partner = require("../models/Partner");
const PartnerUser = require("../models/Partneruser");
const Customer = require("../models/Customer");
const ResellerCustomer = require("../models/ResellerCustomer");
let mongo;
let seq = 0;
function credential(email, overrides = {}) {
  const token = `verified-${++seq}`;
  identities.set(token, { sub: `sub-${email}`, email, email_verified: true, name: "Google Tester", nonce: "test-nonce", ...overrides });
  return { credential: token, nonce: "test-nonce" };
}
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([PartnerUser.init(), Customer.init(), ResellerCustomer.init()]);
});
after(async () => {
  OAuth2Client.prototype.verifyIdToken = originalVerify;
  await mongoose.disconnect();
  await mongo.stop();
});

test("Google credentials reject invalid signatures, unverified email and mismatched nonce", async () => {
  for (const body of [{ credential: "fake", nonce: "test-nonce" }, credential("unverified@gmail.com", { email_verified: false }), { ...credential("nonce@gmail.com"), nonce: "wrong" }]) {
    const res = await request(app).post("/api/partner/auth/google/login").send(body);
    assert.equal(res.status, 401);
  }
});

test("partner Google registration ignores browser email and password, logs in, and respects blocked access", async () => {
  const body = credential("partner@gmail.com");
  let res = await request(app).post("/api/partner/auth/google/register").set("X-Session-Mode", "cookie").send({ ...body, email: "attacker@gmail.com", partnerType: "affiliate", phone: "+919876543210" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.user.email, "partner@gmail.com");
  assert.match(res.headers["set-cookie"][0], /spotx_partner=.*HttpOnly/);
  const user = await PartnerUser.findOne({ email: "partner@gmail.com" }).select("+auth.passwordHash +auth.googleSub");
  assert.equal(user.auth.passwordHash, undefined);
  assert.equal(user.auth.googleSub, "sub-partner@gmail.com");
  res = await request(app).post("/api/partner/auth/google/login").send(body);
  assert.equal(res.status, 200);
  res = await request(app).post("/api/partner/auth/google/register").send({ ...body, partnerType: "affiliate", phone: "123" });
  assert.equal(res.status, 409);
  user.status = "blocked"; await user.save();
  res = await request(app).post("/api/partner/auth/google/login").send(body);
  assert.equal(res.status, 403);
});

test("vendor and reseller Google signup retain referral ownership and issue customer sessions", async () => {
  for (const type of ["vendor", "reseller"]) {
    const partner = await Partner.create({ partnerCode: `google-${type}`, partnerType: type, primaryContact: { name: "Test", email: `${type}@example.com`, phone: "123" }, status: "active", referral: { referralCode: `google-${type}` } });
    const endpoint = type === "vendor" ? "/api/public/customers" : "/api/public/reseller-customers";
    const body = credential(`${type}-customer@gmail.com`);
    let res = await request(app).post(`${endpoint}/google/register`).send({ ...body, referralCode: "invalid", companyName: "Test company" });
    assert.ok([400, 404].includes(res.status));
    res = await request(app).post(`${endpoint}/google/register`).send({ ...body, referralCode: `google-${type}`, companyName: "Test company" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.token);
    const model = type === "vendor" ? Customer : ResellerCustomer;
    const customer = await model.findOne({ "auth.googleSub": `sub-${type}-customer@gmail.com` }).select("+auth.passwordHash");
    assert.equal(String(customer.partnerId), String(partner._id));
    assert.equal(customer.auth.emailVerified, true);
    assert.equal(customer.auth.passwordHash, undefined);
    res = await request(app).post(`${endpoint}/google/login`).send(body);
    assert.equal(res.status, 200);
    customer.status = "suspended"; await customer.save();
    res = await request(app).post(`${endpoint}/google/login`).send(body);
    assert.equal(res.status, 403);
  }
});

test("existing account linking requires authoritative Google email and never changes password", async () => {
  await Customer.create({ companyName: "Existing", email: "existing@gmail.com", partnerId: new mongoose.Types.ObjectId(), auth: { passwordHash: "existing-hash", emailVerified: false } });
  let res = await request(app).post("/api/public/customers/google/login").send(credential("existing@gmail.com"));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const customer = await Customer.findOne({ email: "existing@gmail.com" }).select("+auth.passwordHash +auth.googleSub");
  assert.equal(customer.auth.passwordHash, "existing-hash");
  assert.equal(customer.auth.emailVerified, true);
  res = await request(app).post("/api/public/customers/google/login").send(credential("existing@gmail.com", { sub: "other-google-user" }));
  assert.equal(res.status, 409);
  await Customer.create({ companyName: "External", email: "external@example.com", partnerId: new mongoose.Types.ObjectId() });
  res = await request(app).post("/api/public/customers/google/login").send(credential("external@example.com"));
  assert.equal(res.status, 409);
  res = await request(app).post("/api/public/customers/google/login").send(credential("unknown@gmail.com"));
  assert.equal(res.status, 404);
});
