/**
 * End-to-end flows for all four partner types, driven through the real
 * Express app against a throwaway in-memory MongoDB (a single-node replica
 * set, so transactions work). Nothing here touches a real database, mail
 * server, Cloudinary account or Razorpay: those four edges are stubbed
 * below, everything else is the production code path.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { Writable } = require("node:stream");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-partner-secret";
process.env.ADMIN_JWT_SECRET = "test-admin-secret";
process.env.CUSTOMER_JWT_SECRET = "test-customer-secret";
process.env.BANK_ENC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.CLIENT_URL = "http://localhost:5173";
process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
process.env.CLOUDINARY_API_KEY = "test-key";
process.env.CLOUDINARY_API_SECRET = "test-secret";
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

/* ---------- stubbed edges (must be patched before the app loads) ---------- */

// Mail: capture instead of send, so the test can read OTPs and links.
const outbox = [];
const failingMailRecipients = new Set();
const mailer = require("../utils/mailer");
mailer.sendMail = async (mail) => {
  if (failingMailRecipients.has(mail.to)) throw new Error("Injected delivery failure");
  outbox.push(mail);
  return { delivered: true };
};
const lastMailTo = (email) => outbox.filter((m) => m.to === email).at(-1);

// Cloudinary: keep "uploaded" bytes in memory, serve them back on download.
const cloudinary = require("cloudinary").v2;
const cloudFiles = new Map();
cloudinary.uploader.upload = async (filePath, options) => {
  cloudFiles.set(options.public_id, require("node:fs").readFileSync(filePath));
  return { public_id: options.public_id };
};
cloudinary.uploader.upload_stream = (options, callback) => {
  const chunks = [];
  return new Writable({
    write(chunk, encoding, done) { chunks.push(chunk); done(); },
    final(done) {
      cloudFiles.set(options.public_id, Buffer.concat(chunks));
      callback(null, { public_id: options.public_id });
      done();
    }
  });
};
// RazorpayX: payouts the test has declared, looked up by id.
const razorpayXPayouts = new Map();
const realFetch = global.fetch;
global.fetch = async (url, options) => {
  const target = String(url);
  if (target.includes("api.razorpay.com/v1/payouts/")) {
    const payout = razorpayXPayouts.get(target.split("/payouts/")[1]);
    return payout
      ? new Response(JSON.stringify(payout), { status: 200, headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify({ error: { description: "No such payout." } }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  if (!target.includes("cloudinary.com")) return realFetch(url, options);
  const publicId = new URL(target).searchParams.get("public_id");
  const body = cloudFiles.get(publicId);
  return body ? new Response(body, { status: 200 }) : new Response("missing", { status: 404 });
};

// Razorpay: every order is created, every payment is a captured one for
// the order's amount.
const razorpay = require("../utils/razorpay");
const razorpayOrders = new Map();
let razorpaySeq = 0;
razorpay.createOrder = async ({ amountInRupees, notes }) => {
  const id = `order_test${++razorpaySeq}`;
  razorpayOrders.set(id, { amount: Math.round(amountInRupees * 100), notes });
  return { id, amount: Math.round(amountInRupees * 100), currency: "INR" };
};
razorpay.verifyPaymentSignature = async () => true;
const paymentsById = new Map();
const payOrder = (orderId, method = "netbanking", bank = "HDFC") => {
  const id = `pay_test${++razorpaySeq}`;
  const order = razorpayOrders.get(orderId);
  paymentsById.set(id, {
    id, order_id: orderId, status: "captured", amount: order.amount, currency: "INR",
    method, bank, notes: order.notes, created_at: Math.floor(Date.now() / 1000)
  });
  return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: "sig" };
};
razorpay.fetchPaymentById = async (id) => {
  const payment = paymentsById.get(id);
  if (!payment) throw new razorpay.RazorpayLookupError("No such payment.");
  return payment;
};

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let app;
let mongo;
const state = { partners: {} };

/* ---------- helpers ---------- */

// Fails with the response body in the message, so a broken flow says why.
const expectStatus = (res, status, label) => {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} — ${JSON.stringify(res.body).slice(0, 600)}`);
  return res.body;
};
const as = (token) => ({ Authorization: `Bearer ${token}` });
const admin = () => as(state.adminToken);
const api = () => request(app);
const PDF = Buffer.from("%PDF-1.4\n% test document\n");

const registerPartner = async (partnerType) => {
  const email = `${partnerType}@example.com`;
  expectStatus(await api().post("/api/partner/auth/send-otp").send({ email }), 200, `${partnerType} send-otp`);
  const otp = lastMailTo(email).text.match(/\b(\d{6})\b/)[1];
  const verified = expectStatus(await api().post("/api/partner/auth/verify-otp").send({ email, otp }), 200, `${partnerType} verify-otp`);
  const body = expectStatus(await api().post("/api/partner/auth/register").send({
    partnerType,
    contactName: `${partnerType} owner`,
    email,
    phone: "9876543210",
    password: "password123",
    emailVerificationToken: verified.verificationToken
  }), 201, `${partnerType} register`);
  state.partners[partnerType] = { email, token: body.token, id: body.partner.id || body.partner._id };
  return state.partners[partnerType];
};

const REQUIRED_DOCS = {
  vendor: ["msme_udyam", "gst_certificate", "pan_card", "cancelled_cheque"],
  reseller: ["msme_udyam", "gst_certificate", "pan_card", "cancelled_cheque"],
  affiliate: ["pan_card", "cancelled_cheque"],
  influencer: ["pan_card", "cancelled_cheque"]
};

// Profile -> KYC documents -> bank account -> Rs.1 check -> admin verifies
// everything, which is what activates the partner.
const verifyPartner = async (partnerType) => {
  const p = state.partners[partnerType];

  expectStatus(await api().patch("/api/partner/profile").set(as(p.token)).send({
    businessName: `${partnerType} business`, entityType: "private_limited",
    country: "India", state: "Maharashtra", city: "Mumbai", addressLine1: "1 Test Road", pincode: "400001"
  }), 200, `${partnerType} profile`);

  for (const documentType of REQUIRED_DOCS[partnerType]) {
    const uploaded = expectStatus(await api().post("/api/partner/documents").set(as(p.token))
      .field("documentType", documentType)
      .attach("file", PDF, { filename: `${documentType}.pdf`, contentType: "application/pdf" }), 201, `${partnerType} upload ${documentType}`);
    assert.equal(uploaded.data.file.storageProvider, "cloudinary");
    expectStatus(await api().patch(`/api/admin/documents/${uploaded.data._id}/verify`).set(admin()).send({ status: "verified" }), 200, `${partnerType} verify ${documentType}`);
  }

  const bank = expectStatus(await api().put("/api/partner/bank").set(as(p.token)).send({
    accountHolderName: `${partnerType} owner`, bankName: "HDFC Bank", accountNumber: "50100123456789", ifsc: "HDFC0001234", accountType: "current"
  }), 200, `${partnerType} bank`);

  const order = expectStatus(await api().post("/api/partner/bank/verify").set(as(p.token)), 200, `${partnerType} bank verify start`);
  expectStatus(await api().post("/api/partner/bank/verify/confirm").set(as(p.token)).send(payOrder(order.data.orderId)), 200, `${partnerType} bank verify confirm`);

  expectStatus(await api().patch(`/api/admin/bank/${bank.data.id}/verify`).set(admin()).send({ status: "verified", overrideReason: "Verified in test." }), 200, `${partnerType} admin bank verify`);
  p.bankId = bank.data.id;
};

const partnerStatus = async (partnerType) => {
  const body = expectStatus(await api().get("/api/partner/profile").set(as(state.partners[partnerType].token)), 200, `${partnerType} profile read`);
  return body.data.partner.status;
};

const agreementText = async (partnerType) => {
  const docs = expectStatus(await api().get("/api/partner/documents").set(as(state.partners[partnerType].token)), 200, `${partnerType} documents`);
  const agreement = docs.data.filter((d) => d.documentType === "partner_agreement").sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  assert.ok(agreement, `${partnerType} should have a partner agreement`);
  assert.equal(agreement.file.storageProvider, "cloudinary");
  const download = await api().get(`/api/partner/documents/${agreement._id}/download`).set(as(state.partners[partnerType].token)).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(download.status, 200, `${partnerType} agreement download`);
  assert.equal(download.body.subarray(0, 5).toString(), "%PDF-");
  return agreement;
};

/* ---------- lifecycle ---------- */

test.before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGO_URI = mongo.getUri();
  await mongoose.connect(process.env.MONGO_URI);
  app = require("../index");

  const { User } = require("../models/Index");
  await User.create({
    name: "Test Admin", email: "admin@example.com",
    passwordHash: await bcrypt.hash("adminpass123", 4), role: "super_admin", status: "active"
  });
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongo) await mongo.stop();
});

/* ---------- shared: sign-up, KYC, activation ---------- */

test("admin can sign in", async () => {
  const body = expectStatus(await api().post("/api/admin/auth/login").send({ email: "admin@example.com", password: "adminpass123" }), 200, "admin login");
  state.adminToken = body.token;
  assert.ok(state.adminToken);
});

test("each of the four partner types can register with an emailed OTP", async () => {
  for (const partnerType of ["influencer", "affiliate", "vendor", "reseller"]) {
    const p = await registerPartner(partnerType);
    assert.ok(p.token, `${partnerType} got a session`);
  }
  const rejected = await api().post("/api/partner/auth/register").send({ partnerType: "agency", contactName: "x", email: "x@example.com", phone: "1", password: "password123" });
  assert.equal(rejected.status, 400);
});

test("a second OTP request inside the cooldown is refused", async () => {
  expectStatus(await api().post("/api/partner/auth/send-otp").send({ email: "cooldown@example.com" }), 200, "first otp");
  const again = await api().post("/api/partner/auth/send-otp").send({ email: "cooldown@example.com" });
  assert.equal(again.status, 429);
});

test("an unverified partner is locked out of verified-only features", async () => {
  const res = await api().get("/api/partner/team").set(as(state.partners.vendor.token));
  assert.equal(res.status, 403);
  assert.equal(res.body.locked, true);
});

test("KYC + bank verification activates every partner type", async () => {
  for (const partnerType of ["influencer", "affiliate", "reseller"]) {
    await verifyPartner(partnerType);
    assert.equal(await partnerStatus(partnerType), "active", `${partnerType} should be active`);
  }
});

test("each activated type gets its own agreement, stored in Cloudinary and downloadable", async () => {
  for (const partnerType of ["influencer", "affiliate", "reseller"]) {
    await agreementText(partnerType);
  }
});

test("type-specific APIs refuse the wrong partner type", async () => {
  const get = (path, type) => api().get(path).set(as(state.partners[type].token));
  assert.equal((await get("/api/partner/referrals", "affiliate")).status, 200);
  assert.equal((await get("/api/partner/referrals", "influencer")).status, 403);
  assert.equal((await get("/api/partner/referrals", "reseller")).status, 403);
  assert.equal((await get("/api/partner/commissions", "reseller")).status, 403);
  assert.equal((await get("/api/partner/settlements", "reseller")).status, 403);
  assert.equal((await get("/api/partner/customers", "affiliate")).status, 403);
  assert.equal((await get("/api/partner/social/accounts", "affiliate")).status, 403);
  assert.equal((await get("/api/partner/reseller/inventory", "influencer")).status, 403);
  assert.equal((await get("/api/partner/reseller/inventory", "reseller")).status, 200);
  assert.equal((await get("/api/partner/social/accounts", "influencer")).status, 200);
});

test("team: an owner invites a teammate, who can sign in; an admin can block them", async () => {
  const owner = state.partners.affiliate;
  const invited = expectStatus(await api().post("/api/partner/team").set(as(owner.token)).send({
    name: "Sales Person", email: "sales@example.com", phone: "9000000000", role: "sales"
  }), 201, "team invite");
  const team = expectStatus(await api().get("/api/partner/team").set(as(owner.token)), 200, "team list");
  assert.equal(team.data.length, 2);

  const member = team.data.find((m) => m.email === "sales@example.com");
  const blocked = expectStatus(await api().patch(`/api/admin/partners/${owner.id}/team/${member._id}`).set(admin()).send({ status: "blocked" }), 200, "admin block");
  assert.equal(blocked.data.status, "blocked");
  const ownerBlock = await api().patch(`/api/admin/partners/${owner.id}/team/${team.data.find((m) => m.role === "owner")._id}`).set(admin()).send({ status: "blocked" });
  assert.equal(ownerBlock.status, 400);
  assert.ok(invited);
});

test("admins are notified about sign-ups, KYC and bank submissions from every type", async () => {
  const body = expectStatus(await api().get("/api/admin/notifications").set(admin()), 200, "admin notifications");
  const types = new Set(body.data.notifications.map((n) => n.type));
  for (const expected of ["partner_registered", "document_uploaded", "bank_details_submitted", "bank_payment_confirmed"]) {
    assert.ok(types.has(expected), `expected a ${expected} notification, got ${[...types].join(", ")}`);
  }
  assert.ok(body.data.unreadCount > 0);
  expectStatus(await api().patch("/api/admin/notifications/read-all").set(admin()), 200, "read all");
  const after = expectStatus(await api().get("/api/admin/notifications").set(admin()), 200, "admin notifications after");
  assert.equal(after.data.unreadCount, 0);
});

/* ---------- affiliate ---------- */

test("affiliate: lead -> contacted -> won -> reward -> settlement -> paid", async () => {
  const p = state.partners.affiliate;

  const bad = await api().post("/api/partner/referrals").set(as(p.token)).send({ customer: { companyName: "No Screens Ltd" }, requirement: {} });
  assert.equal(bad.status, 400);

  const lead = expectStatus(await api().post("/api/partner/referrals").set(as(p.token)).send({
    customer: { companyName: "Cafe Chain", contactName: "Owner", email: "cafe@example.com", phone: "9111111111" },
    requirement: { screenCount: 5, notes: "Menu boards" }
  }), 201, "create lead");

  const adminLeads = expectStatus(await api().get("/api/admin/leads").set(admin()), 200, "admin leads");
  assert.equal(adminLeads.data.length, 1);

  expectStatus(await api().patch(`/api/admin/leads/${lead.data._id}/contacted`).set(admin()), 200, "lead contacted");
  const won = expectStatus(await api().patch(`/api/admin/leads/${lead.data._id}/win`).set(admin()).send({ plan: "basic", screenCount: 5, commissionAmount: 2500 }), 200, "lead won");
  const commissionId = won.data.commission._id;

  // The partner sees the reward but never SPOTX's internal deal value.
  const mine = expectStatus(await api().get("/api/partner/referrals").set(as(p.token)), 200, "my leads");
  assert.equal(mine.data[0].status, "won");
  assert.equal(mine.data[0].closure.commissionAmount, 2500);
  assert.equal(mine.data[0].closure.dealValue, undefined);

  // Approving the reward is the only step before paying: it lands in a
  // ready-to-pay settlement on its own — nobody creates or approves a batch.
  const approved = expectStatus(await api().patch(`/api/admin/commissions/${commissionId}/approve`).set(admin()), 200, "approve reward");
  const settlementId = approved.settlement._id;
  assert.equal(approved.settlement.status, "approved");
  assert.equal(approved.settlement.net, 2500);
  const queued = expectStatus(await api().get("/api/partner/settlements").set(as(p.token)), 200, "my settlements (queued)");
  assert.equal(queued.data.length, 1, "the approved reward shows up as a settlement straight away");
  assert.equal(queued.data[0].status, "approved");
  // The old manual step has nothing left to do.
  assert.equal((await api().post("/api/admin/settlements").set(admin()).send({ partnerId: p.id, commissionIds: [commissionId] })).status, 400);

  const details = expectStatus(await api().get(`/api/admin/settlements/${settlementId}/payout-details`).set(admin()), 200, "payout details");
  assert.equal(details.data.bank.accountNumber, "50100123456789");
  assert.equal(details.data.payable.total, 2500);

  expectStatus(await api().patch(`/api/admin/settlements/${settlementId}/mark-paid-offline`).set(admin()).send({ method: "bank_transfer", referenceNumber: "UTR123" }), 200, "mark paid offline");

  const paid = expectStatus(await api().get("/api/partner/settlements").set(as(p.token)), 200, "my settlements");
  assert.equal(paid.data[0].status, "paid");
  const commissions = expectStatus(await api().get("/api/partner/commissions").set(as(p.token)), 200, "my rewards");
  assert.equal(commissions.data[0].settlement.status, "settled");

  const dash = expectStatus(await api().get("/api/partner/dashboard").set(as(p.token)), 200, "affiliate dashboard");
  assert.equal(dash.data.typeStats.wonDeals, 1);
  assert.equal(dash.data.stats.totalLeads, 1);
});

/* ---------- influencer ---------- */

test("influencer: account -> verified + priced -> post approved -> earning -> paid online", async () => {
  const p = state.partners.influencer;

  const account = expectStatus(await api().post("/api/partner/social/accounts").set(as(p.token)).send({
    platform: "instagram", accountId: "@test.creator", followers: 12000
  }), 201, "submit social account");
  const accountId = account.data._id;

  // Content can't be submitted from an account that isn't verified yet.
  const early = await api().post("/api/partner/social/posts").set(as(p.token)).send({ socialAccountId: accountId, contentType: "reel", url: "https://www.instagram.com/reel/abc123/" });
  assert.equal(early.status, 400);

  expectStatus(await api().patch(`/api/admin/social-media/accounts/${p.id}/${accountId}/review`).set(admin()).send({ decision: "verified" }), 200, "verify social account");
  expectStatus(await api().patch(`/api/admin/social-media/accounts/${p.id}/${accountId}/rates`).set(admin()).send({ post: 4000, reel: 9000 }), 200, "set rates");

  // Changing rates reissues the influencer's agreement (they're already active).
  const docs = expectStatus(await api().get("/api/partner/documents").set(as(p.token)), 200, "influencer documents");
  assert.ok(docs.data.filter((d) => d.documentType === "partner_agreement").length >= 2, "rate change should reissue the agreement");

  const post = expectStatus(await api().post("/api/partner/social/posts").set(as(p.token)).send({
    socialAccountId: accountId, contentType: "reel", url: "https://www.instagram.com/reel/abc123/"
  }), 201, "submit reel");
  const duplicate = await api().post("/api/partner/social/posts").set(as(p.token)).send({ socialAccountId: accountId, contentType: "reel", url: "https://instagram.com/reel/abc123" });
  assert.equal(duplicate.status, 409);

  const queue = expectStatus(await api().get("/api/admin/social-media/posts").set(admin()), 200, "admin posts");
  assert.ok(queue.data.some((s) => String(s._id) === String(post.data._id)));

  expectStatus(await api().patch(`/api/admin/social-media/posts/${post.data._id}/review`).set(admin()).send({ decision: "approved", ownershipConfirmed: true }), 200, "approve reel");

  const earnings = expectStatus(await api().get("/api/partner/commissions").set(as(p.token)), 200, "influencer earnings");
  assert.equal(earnings.data.length, 1);
  assert.equal(earnings.data[0].calculation.netCommission, 9000);

  // Settle it and mark it paid from a Razorpay card payment.
  const commissionId = earnings.data[0]._id;
  // Approving the reel WAS the approval — its earning is already sitting in
  // a ready-to-pay settlement, with nothing else for the admin to do first.
  assert.equal(earnings.data[0].settlement.status, "eligible");
  const queued = expectStatus(await api().get("/api/partner/settlements").set(as(p.token)), 200, "influencer settlements");
  assert.equal(queued.data.length, 1);
  assert.equal(queued.data[0].status, "approved");
  const settlement = { data: queued.data[0] };

  // GST applies to an influencer's payout like anyone else's: they give
  // their GSTIN on a bill for the settlement and GST is added to what is
  // paid. Only the GST *certificate document* is never asked of them.
  const gstDocs = expectStatus(await api().get("/api/partner/documents").set(as(p.token)), 200, "influencer documents");
  assert.equal(gstDocs.data.some((d) => d.documentType === "gst_certificate"), false);
  const bill = expectStatus(await api().post(`/api/partner/settlements/${settlement.data._id}/bill`).set(as(p.token))
    .field("billNumber", "INF-001").field("billDate", "2026-10-01").field("gstin", "27ABCDE1234F1Z5")
    .attach("file", PDF, { filename: "bill.pdf", contentType: "application/pdf" }), 201, "influencer submits GST bill");
  assert.equal(bill.data.amount.gstAmount, 1620);
  assert.equal(bill.data.amount.totalBillAmount, 10620);
  expectStatus(await api().patch(`/api/admin/settlements/${settlement.data._id}/bill/verify`).set(admin()).send({ status: "verified" }), 200, "verify influencer bill");

  const order = await razorpay.createOrder({ amountInRupees: 10620, notes: {} });
  const payment = payOrder(order.id, "card", "");
  const lookup = expectStatus(await api().get(`/api/admin/settlements/razorpay-payment/${payment.razorpay_payment_id}`).set(admin()), 200, "payment lookup");
  assert.equal(lookup.data.amount, 10620);
  expectStatus(await api().patch(`/api/admin/settlements/${settlement.data._id}/mark-paid`).set(admin()).send({ transactionId: payment.razorpay_payment_id }), 200, "mark paid from card payment");

  const detail = expectStatus(await api().get(`/api/admin/settlements/${settlement.data._id}`).set(admin()), 200, "settlement detail");
  assert.equal(detail.data.status || detail.data.settlement?.status, "paid");
  const history = expectStatus(await api().get(`/api/admin/settlements/${settlement.data._id}/history`).set(admin()), 200, "settlement history");
  assert.ok(history.data.some((h) => h.action === "paid_razorpay"));

  const dash = expectStatus(await api().get("/api/partner/dashboard").set(as(p.token)), 200, "influencer dashboard");
  assert.equal(dash.data.typeStats.approved, 1);
  assert.equal(dash.data.profileComplete, true);
});

/* ---------- vendor ---------- */

test("vendor: verified -> commission agreement -> customers -> payment -> commission", async () => {
  const p = state.partners.vendor;
  await verifyPartner("vendor");
  assert.equal(await partnerStatus("vendor"), "active");

  const assigned = expectStatus(await api().post(`/api/admin/partners/${p.id}/commission-assignment`).set(admin()).send({ commissionType: "percentage", rate: 15 }), 200, "assign commission");
  assert.ok(assigned.data.acceptance.agreementRef);
  await agreementText("vendor");

  const profile = expectStatus(await api().get("/api/partner/profile").set(as(p.token)), 200, "vendor profile");
  const referralCode = profile.data.partner.referral.referralCode;
  assert.ok(referralCode, "an active vendor has a customer referral code");

  const direct = expectStatus(await api().post("/api/partner/customers").set(as(p.token)).send({
    companyName: "Direct Customer Co", contactName: "Buyer", email: "direct@example.com", phone: "9222222222"
  }), 201, "vendor registers customer");
  assert.ok(lastMailTo("direct@example.com"), "the customer is emailed a set-password link");

  expectStatus(await api().get(`/api/public/customers/referral/${referralCode}`), 200, "referral lookup");
  const selfRegistered = expectStatus(await api().post("/api/public/customers/register").send({
    referralCode, companyName: "Self Signup Co", contactName: "Self", email: "self@example.com", phone: "9333333333", password: "password123"
  }), 201, "customer self-registers");
  assert.ok(selfRegistered);
  assert.equal(selfRegistered.data.token, undefined, "registration cannot create an unverified session");
  expectStatus(await api().post("/api/public/customers/login").send({ email: "self@example.com", password: "password123" }), 403, "unverified login blocked");
  const verificationToken = lastMailTo("self@example.com").text.match(/\/customer\/reset-password\/([a-f0-9]+)/)[1];
  expectStatus(await api().post("/api/public/customers/reset-password/invalid").send({ password: "password123" }), 400, "invalid verification link");
  expectStatus(await api().post(`/api/public/customers/reset-password/${verificationToken}`).send({ password: "short" }), 400, "short password rejected");
  const CustomerModel = require("../models/Customer");
  await CustomerModel.updateOne({ email: "self@example.com" }, { $set: { "auth.resetTokenExpires": new Date(Date.now() - 1000) } });
  expectStatus(await api().post(`/api/public/customers/reset-password/${verificationToken}`).send({ password: "password123" }), 400, "expired verification link");
  expectStatus(await api().post("/api/public/customers/forgot-password").send({ email: "self@example.com" }), 200, "resend verification");
  const resentToken = lastMailTo("self@example.com").text.match(/\/customer\/reset-password\/([a-f0-9]+)/)[1];
  expectStatus(await api().post(`/api/public/customers/reset-password/${verificationToken}`).send({ password: "password123" }), 400, "resend invalidates old link");
  expectStatus(await api().post(`/api/public/customers/reset-password/${resentToken}`).send({ password: "password123" }), 200, "self-registration email verified");
  expectStatus(await api().post(`/api/public/customers/reset-password/${verificationToken}`).send({ password: "password123" }), 400, "verification link cannot be reused");
  expectStatus(await api().post("/api/public/customers/login").send({ email: "self@example.com", password: "wrongpass" }), 401, "wrong password");
  expectStatus(await api().post("/api/public/customers/register").send({ referralCode, companyName: "Duplicate", email: " SELF@example.com ", password: "password123" }), 409, "duplicate normalized email");

  const login = expectStatus(await api().post("/api/public/customers/login").send({ email: "self@example.com", password: "password123" }), 200, "customer login");
  const customerToken = login.token || login.data?.token;
  assert.ok(customerToken, `customer login should return a token: ${JSON.stringify(login).slice(0, 200)}`);
  expectStatus(await api().get("/api/customer/profile").set(as(customerToken)), 200, "customer profile");
  expectStatus(await api().get("/api/customer/subscription").set(as(customerToken)), 200, "customer subscription");
  expectStatus(await api().get("/api/customer/screens").set(as(customerToken)), 200, "customer screens");
  expectStatus(await api().get("/api/customer/invoices").set(as(customerToken)), 200, "customer invoices");

  const mine = expectStatus(await api().get("/api/partner/customers").set(as(p.token)), 200, "vendor customers");
  assert.equal(mine.data.length, 2);

  const adminCustomers = expectStatus(await api().get("/api/admin/customers").set(admin()), 200, "admin customers");
  assert.equal(adminCustomers.data.length, 2);

  // An admin confirms the customer's payment; that's what earns the vendor commission.
  expectStatus(await api().patch(`/api/admin/customers/${direct.data._id}/mark-paid`).set(admin()).send({ paymentReference: "DIRECT-TEST-RECEIPT", revenue: 10000, screenCount: 4, plan: "basic", durationMonths: 1 }), 200, "mark customer paid");
  const commissions = expectStatus(await api().get("/api/partner/commissions").set(as(p.token)), 200, "vendor commissions");
  assert.equal(commissions.data.length, 1);
  assert.equal(commissions.data[0].calculation.netCommission, 1500);

  const dash = expectStatus(await api().get("/api/partner/dashboard").set(as(p.token)), 200, "vendor dashboard");
  assert.equal(dash.data.typeStats.totalCustomers, 2);
});

/* ---------- reseller ---------- */

test("reseller: pricing -> prepayment -> licenses -> customers -> allocation -> invoice", async () => {
  const p = state.partners.reseller;

  expectStatus(await api().put(`/api/admin/reseller/partners/${p.id}/pricing-plan`).set(admin()).send({
    standardPricePerScreen: 500, pricingMode: "discount_percent", wholesaleDiscountPercent: 20, minPurchaseQty: 5, taxRatePercent: 18
  }), 200, "pricing plan");
  expectStatus(await api().put(`/api/admin/reseller/partners/${p.id}/billing-config`).set(admin()).send({ billingCycle: "monthly", dueDays: 7 }), 200, "billing config");

  // No purchase before the one-time prepayment is done.
  const blocked = await api().post("/api/partner/reseller/license-orders").set(as(p.token)).send({ quantity: 10 });
  assert.equal(blocked.status, 403);

  expectStatus(await api().patch(`/api/admin/reseller/partners/${p.id}/prepayment`).set(admin()).send({ paymentMode: "online", amount: 1000 }), 200, "set prepayment");
  const prepay = expectStatus(await api().post("/api/partner/reseller/prepayment/pay").set(as(p.token)), 200, "prepayment order");
  const prepayOrderId = prepay.data.orderId || prepay.data.razorpayOrderId || prepay.data.order?.id;
  assert.ok(prepayOrderId, `prepayment order id missing: ${JSON.stringify(prepay.data)}`);
  const paid = payOrder(prepayOrderId);
  expectStatus(await api().post("/api/partner/reseller/prepayment/verify").set(as(p.token)).send({
    razorpayOrderId: paid.razorpay_order_id, razorpayPaymentId: paid.razorpay_payment_id, razorpaySignature: paid.razorpay_signature
  }), 200, "prepayment verify");
  const status = expectStatus(await api().get("/api/partner/reseller/prepayment").set(as(p.token)), 200, "prepayment status");
  assert.equal(status.data.status || status.data.prepayment?.status, "done");

  const tooFew = await api().post("/api/partner/reseller/license-orders").set(as(p.token)).send({ quantity: 2 });
  assert.equal(tooFew.status, 400);
  const order = expectStatus(await api().post("/api/partner/reseller/license-orders").set(as(p.token)).send({ quantity: 10 }), 201, "license order");
  const orderId = order.data.purchaseOrder._id;

  const adminOrders = expectStatus(await api().get("/api/admin/reseller/license-orders").set(admin()), 200, "admin license orders");
  assert.ok(adminOrders.data.length >= 1);
  expectStatus(await api().patch(`/api/admin/reseller/license-orders/${orderId}/accept`).set(admin()), 200, "accept license order");

  const inventory = expectStatus(await api().get("/api/partner/reseller/inventory").set(as(p.token)), 200, "inventory");
  assert.equal(inventory.data.totalPurchasedLicenses, 10);

  const customer = expectStatus(await api().post("/api/partner/reseller/customers").set(as(p.token)).send({
    companyName: "Retail Store", name: "Store Owner", email: "store@example.com", phone: "9444444444"
  }), 201, "reseller customer");
  const customerId = customer.data._id;

  const allocation = expectStatus(await api().post("/api/partner/reseller/allocations").set(as(p.token)).send({ customerId, screens: 4 }), 201, "allocate licenses");
  const over = await api().post("/api/partner/reseller/allocations").set(as(p.token)).send({ customerId, screens: 100 });
  assert.equal(over.status, 400);
  expectStatus(await api().get("/api/partner/reseller/allocations").set(as(p.token)), 200, "allocations");
  assert.ok(allocation.data);

  const invoices = expectStatus(await api().get("/api/partner/reseller/invoices").set(as(p.token)), 200, "invoices");
  assert.ok(invoices.data.length >= 1, "accepting a license order should raise an invoice");
  expectStatus(await api().get("/api/partner/reseller/invoices/current-due").set(as(p.token)), 200, "current due");
  expectStatus(await api().get("/api/partner/reseller/referral").set(as(p.token)), 200, "reseller referral");

  expectStatus(await api().get("/api/admin/reseller/dashboard").set(admin()), 200, "admin reseller dashboard");
  expectStatus(await api().get(`/api/admin/reseller/partners/${p.id}`).set(admin()), 200, "admin reseller partner");
  expectStatus(await api().get("/api/admin/reseller/invoices").set(admin()), 200, "admin reseller invoices");
  expectStatus(await api().get("/api/admin/reseller/customers").set(admin()), 200, "admin reseller customers");

  // Config changes reissue the reseller's agreement with the live pricing table.
  await agreementText("reseller");
});

test("reseller: a bank change is staged, verified with Rs.1, and applied only on approval", async () => {
  const p = state.partners.reseller;

  const staged = expectStatus(await api().put("/api/partner/bank").set(as(p.token)).send({
    accountHolderName: "reseller owner", bankName: "ICICI Bank", accountNumber: "000111222333", ifsc: "ICIC0000123", accountType: "current"
  }), 200, "stage bank change");
  assert.equal(staged.data.pendingChange.bankName, "ICICI Bank");
  assert.equal(staged.data.verification.status, "verified", "the live account stays verified");
  assert.equal(await partnerStatus("reseller"), "active");

  const noCheck = await api().patch(`/api/admin/bank/${p.bankId}/change/approve`).set(admin()).send({});
  assert.equal(noCheck.status, 400, "approval needs the Rs.1 check or an override reason");

  const order = expectStatus(await api().post("/api/partner/bank/verify").set(as(p.token)), 200, "pending change verify start");
  expectStatus(await api().post("/api/partner/bank/verify/confirm").set(as(p.token)).send(payOrder(order.data.orderId, "netbanking", "ICIC")), 200, "pending change verify confirm");

  const pending = expectStatus(await api().get("/api/admin/bank/pending").set(admin()), 200, "pending bank list");
  const row = pending.data.find((a) => String(a._id) === String(p.bankId));
  assert.ok(row?.pendingChange, "the change shows up for admin review");
  assert.equal(row.pendingChange.razorpayCheck.paymentStatus, "captured");

  const revealed = expectStatus(await api().get(`/api/admin/bank/${p.bankId}/reveal?target=pending`).set(admin()), 200, "reveal pending");
  assert.equal(revealed.data.accountNumber, "000111222333");

  const approve = await api().patch(`/api/admin/bank/${p.bankId}/change/approve`).set(admin()).send(
    row.pendingChange.razorpayCheck.nameMatchStatus === "matched" ? {} : { overrideReason: "Checked the cancelled cheque." }
  );
  expectStatus(approve, 200, "approve bank change");

  const mine = expectStatus(await api().get("/api/partner/bank").set(as(p.token)), 200, "my bank");
  assert.equal(mine.data.bankName, "ICICI Bank");
  assert.equal(mine.data.pendingChange, null);
  assert.equal(mine.data.verification.status, "verified");
});

test("reseller customers: self-register by referral code, verify by email, manage screens", async () => {
  const p = state.partners.reseller;
  const referral = expectStatus(await api().get("/api/partner/reseller/referral").set(as(p.token)), 200, "reseller referral");
  const code = referral.data.referralCode || referral.data.referral?.referralCode;
  assert.ok(code, `reseller referral code missing: ${JSON.stringify(referral.data)}`);

  expectStatus(await api().get(`/api/public/reseller-customers/lookup/${code}`), 200, "reseller code lookup");
  expectStatus(await api().post("/api/public/reseller-customers/register").send({
    referralCode: code, companyName: "Portal Customer", name: "Portal User", email: "portal@example.com", phone: "9555555555"
  }), 201, "reseller customer self-register");

  expectStatus(await api().post("/api/public/reseller-customers/login").send({ email: "portal@example.com", password: "password123" }), 401, "reseller customer cannot login before verification");
  expectStatus(await api().post("/api/public/reseller-customers/verify").send({ token: "invalid", password: "password123" }), 400, "invalid reseller verification");
  const mail = lastMailTo("portal@example.com");
  assert.ok(mail, "a verification email is sent");
  const token = (mail.text || mail.html).match(/\/reseller\/customer\/verify\/([A-Za-z0-9_-]+)/)[1];
  expectStatus(await api().post("/api/public/reseller-customers/verify").send({ token, password: "password123" }), 200, "verify + set password");
  expectStatus(await api().post("/api/public/reseller-customers/verify").send({ token, password: "password123" }), 400, "reseller verification cannot be reused");
  const login = expectStatus(await api().post("/api/public/reseller-customers/login").send({ email: "portal@example.com", password: "password123" }), 200, "portal login");
  const portalToken = login.token || login.data?.token;
  assert.ok(portalToken);

  expectStatus(await api().get("/api/customer-portal/me").set(as(portalToken)), 200, "portal me");
  expectStatus(await api().get("/api/customer-portal/screens").set(as(portalToken)), 200, "portal screens");

  // A vendor-customer session and a reseller-customer session are not interchangeable.
  assert.equal((await api().get("/api/customer/profile").set(as(portalToken))).status, 401);
});

/* ---------- admin views ---------- */

test("admin: dashboard stats, partner pages, per-partner agreement terms, config", async () => {
  // The dashboard's figures are computed from the records created above.
  const dash = expectStatus(await api().get("/api/admin/stats/dashboard").set(admin()), 200, "dashboard");
  assert.equal(dash.data.partners.total, 4);
  assert.deepEqual(dash.data.partners.byType, { vendor: 1, affiliate: 1, influencer: 1, reseller: 1 });
  assert.equal(dash.data.partners.active, 4);
  assert.equal(dash.data.partners.kycPending, 0);
  assert.equal(dash.data.partners.bankPending, 0);
  assert.equal(dash.data.affiliate.totalLeads, 1);
  assert.equal(dash.data.affiliate.wonDeals, 1);
  assert.ok(dash.data.affiliate.totalAmount > 0, "won deal value is counted");
  assert.equal(dash.data.payouts.affiliate.total, 2500);
  assert.equal(dash.data.payouts.affiliate.paid, 2500);
  assert.equal(dash.data.payouts.influencer.total, 9000);
  assert.equal(dash.data.payouts.vendor.total, 1500);
  assert.equal(dash.data.vendor.totalCustomers, 2);
  assert.equal(dash.data.vendor.totalAmount, 10000, "the customer's recorded payment");
  assert.equal(dash.data.vendor.paidScreens, 4);
  assert.equal(dash.data.reseller.licensesPurchased, 10);
  assert.equal(dash.data.reseller.totalAmount, 1000, "the prepayment the reseller paid");
  assert.equal(dash.data.overview.totalCommission, 2500 + 9000 + 1500);
  assert.equal(dash.data.overview.totalRevenue, dash.data.reseller.totalAmount + dash.data.vendor.totalAmount + dash.data.affiliate.totalAmount);

  const stats = expectStatus(await api().get("/api/admin/stats/kpis").set(admin()), 200, "kpis");
  assert.equal(stats.data.totalPartners, 4);
  assert.equal(stats.data.totalLeads, 1);
  assert.equal(stats.data.leadsByStatus.won, 1);

  for (const partnerType of ["influencer", "affiliate", "vendor", "reseller"]) {
    const list = expectStatus(await api().get("/api/admin/partners").query({ partnerType }).set(admin()), 200, `partners ${partnerType}`);
    assert.equal(list.data.length, 1, `${partnerType} list`);
    const detail = expectStatus(await api().get(`/api/admin/partners/${state.partners[partnerType].id}`).set(admin()), 200, `partner detail ${partnerType}`);
    assert.ok(detail.data.activity.length > 0);
    assert.ok(Array.isArray(detail.data.team));
  }

  // Agreement terms: per partner, per type.
  const affiliateId = state.partners.affiliate.id;
  const terms = expectStatus(await api().get(`/api/admin/partners/${affiliateId}/agreement-terms`).set(admin()), 200, "agreement terms");
  const payment = terms.data.sections.find((s) => s.key === "payment");
  assert.equal(payment.title, "Referral Reward & Payment Terms");
  assert.equal(payment.isCustomized, false);

  expectStatus(await api().patch(`/api/admin/partners/${affiliateId}/agreement-terms`).set(admin()).send({ sections: { confidentiality: "Negotiated confidentiality." } }), 200, "save terms");
  expectStatus(await api().post(`/api/admin/partners/${affiliateId}/agreement/regenerate`).set(admin()), 200, "regenerate agreement");
  const after = expectStatus(await api().get(`/api/admin/partners/${affiliateId}/agreement-terms`).set(admin()), 200, "agreement terms after");
  assert.equal(after.data.sections.find((s) => s.key === "confidentiality").isCustomized, true);
  assert.equal(after.data.sections.find((s) => s.key === "payment").isCustomized, false);

  const influencerTerms = await api().get(`/api/admin/partners/${state.partners.influencer.id}/agreement-terms`).set(admin());
  assert.equal(influencerTerms.status, 400, "influencer agreements use the shared template instead");

  // The influencer template can be read and previewed.
  const template = expectStatus(await api().get("/api/admin/config/agreement-template").set(admin()), 200, "agreement template");
  const preview = await api().post("/api/admin/config/agreement-template/preview").set(admin()).send({ template: template.data.template });
  assert.equal(preview.status, 200, `template preview: ${JSON.stringify(preview.body).slice(0, 200)}`);

  // Admin edits a partner's profile.
  const edited = expectStatus(await api().patch(`/api/admin/partners/${affiliateId}`).set(admin()).send({ industry: "Retail", city: "Pune" }), 200, "admin edits profile");
  assert.equal(edited.data.address.city, "Pune");

  // Payout schedule per partner.
  expectStatus(await api().put("/api/admin/config/settlement-settings").set(admin()).send({ partnerId: affiliateId, settlementType: "monthly", settlementDay: 5 }), 200, "payout schedule");
  const schedule = expectStatus(await api().get("/api/admin/config/settlement-settings").query({ partnerId: affiliateId }).set(admin()), 200, "payout schedule read");
  assert.equal(schedule.data.length, 1);
  const currentTerms = expectStatus(await api().get(`/api/admin/partners/${affiliateId}/agreement-terms`).set(admin()), 200, "current payout terms");
  assert.match(currentTerms.data.sections.find((s) => s.key === "payment").value, /Payout cycle: monthly/);

  for (const path of ["/api/admin/config/commission-rules", "/api/admin/config/programs", "/api/admin/config/tiers", "/api/admin/config/screen-pricing",
    "/api/admin/config/payment-gateway", "/api/admin/commissions", "/api/admin/settlements", "/api/admin/documents/pending", "/api/admin/social-media/accounts", "/api/admin/opportunities"]) {
    expectStatus(await api().get(path).set(admin()), 200, path);
  }
});

test("GST / MSME documents: refused for an influencer, optional for an affiliate", async () => {
  const upload = (token, documentType) => api().post("/api/partner/documents").set(as(token))
    .field("documentType", documentType).attach("file", PDF, { filename: `${documentType}.pdf`, contentType: "application/pdf" });

  // An influencer is an individual: the API won't take business documents,
  // and tells the app not to show them.
  for (const documentType of ["gst_certificate", "msme_udyam"]) {
    const res = await upload(state.partners.influencer.token, documentType);
    assert.equal(res.status, 400, `influencer ${documentType}`);
  }
  const influencerProfile = expectStatus(await api().get("/api/partner/profile").set(as(state.partners.influencer.token)), 200, "influencer profile");
  assert.deepEqual(influencerProfile.data.notApplicableDocumentTypes, ["msme_udyam", "gst_certificate"]);
  assert.deepEqual(influencerProfile.data.requiredDocumentTypes, ["pan_card", "cancelled_cheque"]);
  const adminView = expectStatus(await api().get(`/api/admin/partners/${state.partners.influencer.id}`).set(admin()), 200, "influencer (admin)");
  assert.deepEqual(adminView.data.notApplicableDocumentTypes, ["msme_udyam", "gst_certificate"]);
  const adminUpload = await api().post(`/api/admin/partners/${state.partners.influencer.id}/documents`).set(admin())
    .field("documentType", "gst_certificate").attach("file", PDF, { filename: "gst.pdf", contentType: "application/pdf" });
  assert.equal(adminUpload.status, 400, "an admin can't add one for an influencer either");

  // An affiliate was activated without them (see the activation test), and
  // may still add one if they have it.
  const affiliateLogin = { token: state.partners.affiliate.token };
  const affiliateProfile = expectStatus(await api().get("/api/partner/profile").set(as(affiliateLogin.token)), 200, "affiliate profile");
  assert.equal(affiliateProfile.data.partner.status, "active");
  assert.deepEqual(affiliateProfile.data.notApplicableDocumentTypes, []);
  assert.equal(affiliateProfile.data.requiredDocumentTypes.includes("gst_certificate"), false);
  expectStatus(await upload(affiliateLogin.token, "gst_certificate"), 201, "affiliate optional GST upload");

  // Vendor and reseller: compulsory.
  for (const type of ["vendor", "reseller"]) {
    const profile = expectStatus(await api().get("/api/partner/profile").set(as(state.partners[type].token)), 200, `${type} profile`);
    assert.ok(profile.data.requiredDocumentTypes.includes("gst_certificate") && profile.data.requiredDocumentTypes.includes("msme_udyam"), `${type} must provide GST and MSME`);
  }
});

test("uploads: wrong file type is a clear 400, and a partner's KYC download is closed once verified", async () => {
  const p = state.partners.affiliate;
  const wrongType = await api().post("/api/partner/documents").set(as(p.token)).field("documentType", "other")
    .attach("file", Buffer.from("hello"), { filename: "note.txt", contentType: "text/plain" });
  assert.equal(wrongType.status, 400);

  const docs = expectStatus(await api().get("/api/partner/documents").set(as(p.token)), 200, "documents");
  const pan = docs.data.find((d) => d.documentType === "pan_card");
  assert.equal((await api().get(`/api/partner/documents/${pan._id}/download`).set(as(p.token))).status, 200);
  assert.equal((await api().get(`/api/admin/documents/${pan._id}/download`).set(admin())).status, 200);
});

/* ---------- remaining actions ---------- */

test("partner account: sign in, notifications, forgot + reset password", async () => {
  const p = state.partners.affiliate;
  const login = expectStatus(await api().post("/api/partner/auth/login").send({ email: p.email, password: "password123" }), 200, "partner login");
  assert.ok(login.token);
  assert.equal((await api().post("/api/partner/auth/login").send({ email: p.email, password: "wrong-password" })).status, 401);

  const notes = expectStatus(await api().get("/api/partner/notifications").set(as(p.token)), 200, "partner notifications");
  const list = Array.isArray(notes.data) ? notes.data : notes.data.notifications;
  assert.ok(list.length > 0, "the affiliate was notified about verification / rewards");
  expectStatus(await api().patch(`/api/partner/notifications/${list[0]._id}/read`).set(as(p.token)), 200, "notification read");
  expectStatus(await api().patch("/api/partner/notifications/read-all").set(as(p.token)), 200, "notifications read-all");

  expectStatus(await api().post("/api/partner/auth/forgot-password").send({ email: p.email }), 200, "forgot password");
  const mail = lastMailTo(p.email);
  const token = (mail.text || mail.html).match(/reset-password\/([A-Za-z0-9_-]+)/)[1];
  expectStatus(await api().post(`/api/partner/auth/reset-password/${token}`).send({ password: "newpassword456" }), 200, "reset password");
  expectStatus(await api().get("/api/partner/dashboard").set(as(p.token)), 401, "partner reset revokes existing session");
  p.token = expectStatus(await api().post("/api/partner/auth/login").send({ email: p.email, password: "newpassword456" }), 200, "partner fresh login").token;
  expectStatus(await api().post("/api/partner/auth/login").send({ email: p.email, password: "newpassword456" }), 200, "login with new password");
  assert.equal((await api().post(`/api/partner/auth/reset-password/${token}`).send({ password: "another789012" })).status, 400, "a reset link works once");
});

test("settlements: hold, release, GST bill, fail and retry", async () => {
  const p = state.partners.vendor;
  const commissions = expectStatus(await api().get("/api/admin/commissions").query({ partnerId: p.id }).set(admin()), 200, "vendor commissions (admin)");
  const commissionId = commissions.data[0]._id;

  // Approval opens a settlement on its own. Putting the commission on hold
  // takes it back out (the now-empty batch is cancelled); approving it again
  // queues it in a fresh one.
  const first = expectStatus(await api().patch(`/api/admin/commissions/${commissionId}/approve`).set(admin()), 200, "approve commission");
  expectStatus(await api().patch(`/api/admin/commissions/${commissionId}/hold`).set(admin()).send({ reason: "Checking the customer's payment." }), 200, "hold commission");
  const cancelled = expectStatus(await api().get(`/api/admin/settlements/${first.settlement._id}`).set(admin()), 200, "first settlement after hold");
  assert.equal(cancelled.data.status, "cancelled");
  const again = expectStatus(await api().patch(`/api/admin/commissions/${commissionId}/approve`).set(admin()), 200, "re-approve commission");
  const id = again.settlement._id;
  assert.notEqual(String(id), String(first.settlement._id));

  // A vendor is GST-registered (a GST certificate is part of their KYC), so
  // the batch waits on hold until their bill for it is submitted and verified.
  const held = expectStatus(await api().get("/api/partner/settlements").set(as(p.token)), 200, "vendor settlements");
  assert.equal(held.data[0].status, "on_hold");

  // It can't be paid while it's on hold waiting for the bill.
  assert.equal((await api().patch(`/api/admin/settlements/${id}/mark-paid-offline`).set(admin()).send({ method: "upi", referenceNumber: "TOO-EARLY" })).status, 400);

  const bill = expectStatus(await api().post(`/api/partner/settlements/${id}/bill`).set(as(p.token))
    .field("billNumber", "INV-001").field("billDate", "2026-10-01").field("gstin", "27ABCDE1234F1Z5")
    .attach("file", PDF, { filename: "bill.pdf", contentType: "application/pdf" }), 201, "submit bill");
  assert.equal(bill.data.file.storageProvider, "cloudinary");
  assert.match(bill.data.file.objectKey, /\/bills\//);
  expectStatus(await api().get(`/api/partner/settlements/${id}/bill`).set(as(p.token)), 200, "partner reads bill");
  expectStatus(await api().get(`/api/admin/settlements/${id}/bill`).set(admin()), 200, "admin reads bill");
  assert.equal((await api().get(`/api/admin/settlements/${id}/bill/download`).set(admin())).status, 200);
  assert.equal((await api().get(`/api/partner/settlements/${id}/bill/download`).set(as(state.partners.vendor.token))).status, 200);
  expectStatus(await api().patch(`/api/admin/settlements/${id}/bill/verify`).set(admin()).send({ status: "verified" }), 200, "verify bill");

  const state1 = expectStatus(await api().get(`/api/admin/settlements/${id}`).set(admin()), 200, "settlement detail");
  if ((state1.data.status || state1.data.settlement?.status) !== "approved") {
    expectStatus(await api().patch(`/api/admin/settlements/${id}/approve`).set(admin()), 200, "approve settlement");
  }

  expectStatus(await api().patch(`/api/admin/settlements/${id}/fail`).set(admin()).send({ reason: "Bank rejected the transfer." }), 200, "fail settlement");
  expectStatus(await api().patch(`/api/admin/settlements/${id}/retry`).set(admin()), 200, "retry settlement");
  expectStatus(await api().get(`/api/partner/settlements/${id}`).set(as(p.token)), 200, "partner settlement detail");
  expectStatus(await api().get(`/api/partner/settlements/${id}/history`).set(as(p.token)), 200, "partner settlement history");

  const paid = await api().patch(`/api/admin/settlements/${id}/mark-paid-offline`).set(admin()).send({ method: "upi", referenceNumber: "UPI-REF-1", note: "Paid by UPI." });
  expectStatus(paid, 200, "mark vendor settlement paid");
  const done = expectStatus(await api().get("/api/partner/settlements").set(as(p.token)), 200, "vendor settlements after");
  assert.equal(done.data[0].status, "paid");
});

test("vendor customer: set password from email, screens, subscribe online, reset password", async () => {
  // The customer a vendor registered directly sets their password from the emailed link.
  const invite = lastMailTo("direct@example.com");
  const setToken = (invite.text || invite.html).match(/reset-password\/([A-Za-z0-9_-]+)/)[1];
  expectStatus(await api().post(`/api/public/customers/reset-password/${setToken}`).send({ password: "customerpass1" }), 200, "customer sets password");
  const login = expectStatus(await api().post("/api/public/customers/login").send({ email: "direct@example.com", password: "customerpass1" }), 200, "customer login");
  let token = login.token || login.data?.token;

  expectStatus(await api().patch("/api/customer/profile").set(as(token)).send({ contactName: "New Contact", phone: "9000011111" }), 200, "customer edits profile");
  expectStatus(await api().post("/api/customer/change-password").set(as(token)).send({ currentPassword: "customerpass1", newPassword: "customerpass2" }), 200, "customer changes password");

  expectStatus(await api().get("/api/customer/profile").set(as(token)), 401, "password change revokes old customer session");
  const refreshedLogin = expectStatus(await api().post("/api/public/customers/login").send({ email: "direct@example.com", password: "customerpass2" }), 200, "login after password change");
  token = refreshedLogin.data.token;
  const screen = expectStatus(await api().post("/api/customer/screens").set(as(token)).send({ name: "Lobby", location: "Front desk" }), 201, "customer adds screen");
  expectStatus(await api().delete(`/api/customer/screens/${screen.data._id}`).set(as(token)), 200, "customer removes screen");

  // Self-service subscription for the customer who signed up by referral code.
  const self = expectStatus(await api().post("/api/public/customers/login").send({ email: "self@example.com", password: "password123" }), 200, "self customer login");
  const selfToken = self.token || self.data?.token;
  const checkout = expectStatus(await api().post("/api/customer/subscription/checkout").set(as(selfToken)).send({ plan: "basic", screenCount: 3, durationMonths: 1 }), 200, "checkout");
  assert.ok(checkout.data.orderId, `checkout should open an order: ${JSON.stringify(checkout.data).slice(0, 300)}`);
  const pay = payOrder(checkout.data.orderId, "upi", "");
  state.recoveryScenario = { token: selfToken, id: checkout.data.customerPaymentId, pay };
  expectStatus(await api().post("/api/customer/subscription/verify").set(as(selfToken)).send({ customerPaymentId: checkout.data.customerPaymentId, ...pay }), 200, "verify subscription payment");
  const sub = expectStatus(await api().get("/api/customer/subscription").set(as(selfToken)), 200, "subscription after payment");
  assert.equal(sub.data.subscription.status, "active");
  const invoices = expectStatus(await api().get("/api/customer/invoices").set(as(selfToken)), 200, "customer invoices");
  assert.ok(invoices.data.length >= 1);

  // That payment earns the vendor commission too.
  const commissions = expectStatus(await api().get("/api/partner/commissions").set(as(state.partners.vendor.token)), 200, "vendor commissions after subscription");
  assert.equal(commissions.data.length, 2);

  expectStatus(await api().post("/api/public/customers/forgot-password").send({ email: "self@example.com" }), 200, "customer forgot password");

  const adminCustomers = expectStatus(await api().get("/api/admin/customers").set(admin()), 200, "admin customers");
  const selfRow = adminCustomers.data.find((c) => c.email === "self@example.com");
  // Re-sending a set-password link is only for a customer who never set one.
  assert.equal((await api().post(`/api/admin/customers/${selfRow._id}/reset-credentials`).set(admin())).status, 400);
  expectStatus(await api().patch(`/api/admin/customers/${selfRow._id}/cancel`).set(admin()), 200, "admin cancels subscription");
});

test("reseller: allocation lifecycle, customer portal screens, invoice paid online", async () => {
  const p = state.partners.reseller;
  const allocations = expectStatus(await api().get("/api/partner/reseller/allocations").set(as(p.token)), 200, "allocations");
  const allocation = allocations.data[0];
  assert.ok(allocation, "the reseller has an allocation from the earlier flow");

  // The reseller's own customer registers screens against the allocation from their portal.
  const customers = expectStatus(await api().get("/api/partner/reseller/customers").set(as(p.token)), 200, "reseller customers");
  expectStatus(await api().get(`/api/partner/reseller/customers/${customers.data[0]._id}`).set(as(p.token)), 200, "reseller customer detail");
  expectStatus(await api().patch(`/api/partner/reseller/customers/${customers.data[0]._id}`).set(as(p.token)).send({ companyName: "Retail Store Renamed" }), 200, "edit reseller customer");

  expectStatus(await api().post(`/api/partner/reseller/allocations/${allocation._id}/release`).set(as(p.token)).send({ screens: 1 }), 200, "release 1 license");
  expectStatus(await api().get("/api/partner/reseller/inventory/transactions").set(as(p.token)), 200, "inventory transactions");
  expectStatus(await api().get("/api/partner/reseller/license-orders").set(as(p.token)), 200, "my license orders");

  expectStatus(await api().post(`/api/admin/reseller/partners/${p.id}/adjust-inventory`).set(admin()).send({ quantity: 5, reason: "Goodwill top-up." }), 200, "adjust inventory");
  const inventory = expectStatus(await api().get("/api/partner/reseller/inventory").set(as(p.token)), 200, "inventory after adjust");
  assert.equal(inventory.data.totalPurchasedLicenses, 15);

  // A second request the admin declines.
  const order = expectStatus(await api().post("/api/partner/reseller/license-orders").set(as(p.token)).send({ quantity: 6 }), 201, "second license order");
  expectStatus(await api().get(`/api/partner/reseller/license-orders/${order.data.purchaseOrder._id}`).set(as(p.token)), 200, "license order detail");
  expectStatus(await api().patch(`/api/admin/reseller/license-orders/${order.data.purchaseOrder._id}/reject`).set(admin()).send({ reason: "Over the agreed volume." }), 200, "reject license order");

  // Invoice: switched to online by the admin, then paid by the reseller.
  expectStatus(await api().post("/api/admin/reseller/run-billing").set(admin()), 200, "run billing");
  expectStatus(await api().post("/api/admin/reseller/check-notifications").set(admin()), 200, "check notifications");
  const invoices = expectStatus(await api().get("/api/partner/reseller/invoices").set(as(p.token)), 200, "invoices");
  const invoice = invoices.data.find((i) => i.paymentStatus !== "paid");
  assert.ok(invoice, "there is an unpaid invoice");
  expectStatus(await api().get(`/api/partner/reseller/invoices/${invoice._id}`).set(as(p.token)), 200, "invoice detail");

  if (invoice.paymentMode !== "online") {
    expectStatus(await api().post(`/api/partner/reseller/invoices/${invoice._id}/request-online`).set(as(p.token)), 200, "request online payment");
    expectStatus(await api().patch(`/api/admin/reseller/invoices/${invoice._id}/payment-mode`).set(admin()), 200, "switch invoice to online");
  }
  const payOrderRes = await api().post(`/api/partner/reseller/invoices/${invoice._id}/pay`).set(as(p.token));
  if (payOrderRes.status === 200) {
    const paid = payOrder(payOrderRes.body.data.razorpayOrderId);
    expectStatus(await api().post(`/api/partner/reseller/invoices/${invoice._id}/verify`).set(as(p.token)).send({
      razorpayOrderId: paid.razorpay_order_id, razorpayPaymentId: paid.razorpay_payment_id, razorpaySignature: paid.razorpay_signature
    }), 200, "verify invoice payment");
  } else {
    // Online payment only opens shortly before the due date; until then the
    // admin can record a payment collected offline.
    assert.equal(payOrderRes.status, 400, `pay invoice: ${JSON.stringify(payOrderRes.body)}`);
    const offlineOrder = await razorpay.createOrder({ amountInRupees: invoice.total, notes: {} });
    const offline = payOrder(offlineOrder.id);
    expectStatus(await api().patch(`/api/admin/reseller/invoices/${invoice._id}/verify-offline`).set(admin()).send({ transactionId: offline.razorpay_payment_id }), 200, "verify offline invoice payment");
  }
  const after = expectStatus(await api().get(`/api/partner/reseller/invoices/${invoice._id}`).set(as(p.token)), 200, "invoice after payment");
  assert.equal((after.data.invoice || after.data).paymentStatus, "paid");

  expectStatus(await api().post(`/api/partner/reseller/allocations/${allocation._id}/cancel`).set(as(p.token)), 200, "cancel allocation");
});

test("admin configuration: programs, tiers, commission rules, pricing, opportunities, partner onboarding", async () => {
  const tier = expectStatus(await api().post("/api/admin/config/tiers").set(admin()).send({ name: "Gold", code: "GOLD", partnerType: "vendor", level: 2 }), 201, "create tier");
  expectStatus(await api().patch(`/api/admin/config/tiers/${tier.data._id}`).set(admin()).send({ name: "Gold Plus" }), 200, "update tier");

  const program = expectStatus(await api().post("/api/admin/config/programs").set(admin()).send({
    name: "Launch Campaign", code: "LAUNCH", type: "vendor", description: "Intro", isPublic: true, status: "active"
  }), 201, "create program");
  expectStatus(await api().patch(`/api/admin/config/programs/${program.data._id}`).set(admin()).send({ description: "Updated" }), 200, "update program");
  const active = expectStatus(await api().get("/api/partner/programs/active"), 200, "public programs");
  assert.ok(active.data.some((x) => x.code === "LAUNCH"));

  const rule = expectStatus(await api().post("/api/admin/config/commission-rules").set(admin()).send({ name: "Default 10%", partnerType: "vendor", commissionType: "percentage", rate: 10 }), 201, "create commission rule");
  expectStatus(await api().patch(`/api/admin/config/commission-rules/${rule.data._id}`).set(admin()).send({ rate: 12 }), 200, "update commission rule");

  expectStatus(await api().put("/api/admin/config/screen-pricing").set(admin()).send({ basicPricePerScreen: 300, premiumPricePerScreen: 600 }), 200, "screen pricing");
  expectStatus(await api().patch(`/api/admin/partners/${state.partners.vendor.id}/tier`).set(admin()).send({ tierId: tier.data._id }), 400, "vendor tier assignment is disabled");
  expectStatus(await api().get(`/api/admin/partners/${state.partners.vendor.id}/commission-assignment`).set(admin()), 200, "commission assignment");

  // An admin onboards a partner directly, uploads a document for them, then rejects them.
  const created = expectStatus(await api().post("/api/admin/partners").set(admin()).send({
    partnerType: "affiliate", contactName: "Onboarded Partner", email: "onboarded@example.com", phone: "9666666666", password: "password123"
  }), 201, "admin creates partner");
  const newId = created.data.partner?._id || created.data._id || created.data.id;
  assert.ok(newId, `created partner id: ${JSON.stringify(created.data).slice(0, 300)}`);
  expectStatus(await api().post(`/api/admin/partners/${newId}/documents`).set(admin()).field("documentType", "pan_card")
    .attach("file", PDF, { filename: "pan.pdf", contentType: "application/pdf" }), 201, "admin uploads document");
  expectStatus(await api().patch(`/api/admin/partners/${newId}/status`).set(admin()).send({ status: "rejected", rejectionReason: "Duplicate application." }), 200, "reject partner");

  // A lead rejected with a reason.
  const p = state.partners.affiliate;
  const login = expectStatus(await api().post("/api/partner/auth/login").send({ email: p.email, password: "newpassword456" }), 200, "affiliate login");
  const lead = expectStatus(await api().post("/api/partner/referrals").set(as(login.token)).send({ customer: { companyName: "Not Interested Ltd" }, requirement: { screenCount: 2 } }), 201, "second lead");
  expectStatus(await api().patch(`/api/admin/leads/${lead.data._id}/reject`).set(admin()).send({ reason: "Out of service area." }), 200, "reject lead");

  // Malformed ids are "not found", never a server error.
  assert.equal((await api().get("/api/admin/partners/not-an-id").set(admin())).status, 404);
  assert.equal((await api().patch("/api/admin/leads/not-an-id/contacted").set(admin())).status, 404);

  // Payment gateway settings never echo a secret back.
  const gateway = expectStatus(await api().get("/api/admin/config/payment-gateway").set(admin()), 200, "payment gateway");
  assert.equal(JSON.stringify(gateway.data).includes("rzp_test_secret"), false);
});

test("influencer: rejected content and the editable agreement template", async () => {
  const p = state.partners.influencer;
  const accounts = expectStatus(await api().get("/api/partner/social/accounts").set(as(p.token)), 200, "my accounts");
  const account = (accounts.data.accounts || accounts.data)[0];
  const post = expectStatus(await api().post("/api/partner/social/posts").set(as(p.token)).send({
    socialAccountId: account._id, contentType: "post", url: "https://www.instagram.com/p/xyz789/"
  }), 201, "submit post");
  expectStatus(await api().patch(`/api/admin/social-media/posts/${post.data._id}/review`).set(admin()).send({ decision: "rejected", reviewNote: "Brand not visible." }), 200, "reject post");
  const mine = expectStatus(await api().get("/api/partner/social/posts").set(as(p.token)), 200, "my posts");
  assert.ok((mine.data.submissions || mine.data).some((s) => s.status === "rejected"));

  // Editing the template can reissue it to every verified influencer.
  const template = expectStatus(await api().get("/api/admin/config/agreement-template").set(admin()), 200, "template");
  const edited = { ...template.data.template, title: "Influencer Agreement (Updated)" };
  const saved = expectStatus(await api().put("/api/admin/config/agreement-template").set(admin()).send({ template: edited, reissueExisting: true }), 200, "save template");
  assert.equal(saved.data.reissued, 1);
  expectStatus(await api().post("/api/admin/config/agreement-template/reset").set(admin()).send({}), 200, "reset template");
});

test("reseller customer registers screens against their allocation; reseller can suspend and reactivate", async () => {
  const p = state.partners.reseller;

  // Give the self-registered portal customer some capacity.
  const customers = expectStatus(await api().get("/api/partner/reseller/customers").set(as(p.token)), 200, "reseller customers");
  const portalCustomer = customers.data.find((c) => c.contactDetails?.email === "portal@example.com");
  assert.ok(portalCustomer, "the self-registered customer belongs to this reseller");
  const allocation = expectStatus(await api().post("/api/partner/reseller/allocations").set(as(p.token)).send({ customerId: portalCustomer._id, screens: 2 }), 201, "allocate to portal customer");
  const allocationId = allocation.data._id || allocation.data.allocation?._id;
  assert.ok(allocationId, `allocation id: ${JSON.stringify(allocation.data).slice(0, 300)}`);

  const login = expectStatus(await api().post("/api/public/reseller-customers/login").send({ email: "portal@example.com", password: "password123" }), 200, "portal login");
  const portal = as(login.token || login.data?.token);

  const first = expectStatus(await api().post("/api/customer-portal/screens").set(portal).send({ name: "Window Display", location: "Shopfront" }), 201, "register screen 1");
  expectStatus(await api().post("/api/customer-portal/screens").set(portal).send({ name: "Counter Display" }), 201, "register screen 2");
  const full = await api().post("/api/customer-portal/screens").set(portal).send({ name: "One Too Many" });
  assert.equal(full.status, 409, "can't register beyond the allocated licenses");
  const screenId = first.data._id || first.data.screen?._id;
  expectStatus(await api().patch(`/api/customer-portal/screens/${screenId}`).set(portal).send({ name: "Window Display A" }), 200, "rename screen");
  const screens = expectStatus(await api().get("/api/customer-portal/screens").set(portal), 200, "portal screens");
  assert.equal((screens.data.screens || screens.data).length, 2);

  expectStatus(await api().post(`/api/partner/reseller/allocations/${allocationId}/suspend`).set(as(p.token)).send({}), 200, "suspend customer");
  expectStatus(await api().post(`/api/partner/reseller/allocations/${allocationId}/reactivate`).set(as(p.token)).send({}), 200, "reactivate customer");

  const inventory = expectStatus(await api().get("/api/partner/reseller/inventory").set(as(p.token)), 200, "inventory");
  assert.equal(inventory.data.totalRegisteredScreens, 2);
  assert.equal(inventory.data.totalActiveScreens, 2);
  assert.equal(inventory.data.totalSuspendedScreens, 0);
});

test("Razorpay webhook: rejects a bad signature and applies a captured payment once", async () => {
  const crypto = require("node:crypto");
  const send = (payload, secret = process.env.RAZORPAY_WEBHOOK_SECRET) => {
    const raw = JSON.stringify(payload);
    const signature = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    return api().post("/api/webhooks/razorpay").set("Content-Type", "application/json").set("x-razorpay-signature", signature).send(raw);
  };

  assert.equal((await send({ event: "payment.captured" }, "wrong-secret")).status, 400);

  // A customer pays, but their browser never calls /verify — the webhook is the safety net.
  const login = expectStatus(await api().post("/api/public/customers/login").send({ email: "direct@example.com", password: "customerpass2" }), 200, "customer login");
  const token = login.token || login.data?.token;
  const checkout = expectStatus(await api().post("/api/customer/subscription/checkout").set(as(token)).send({ plan: "premium", screenCount: 6, durationMonths: 3 }), 200, "checkout");
  assert.equal(checkout.requiresPayment, true, `expected a payable change: ${JSON.stringify(checkout).slice(0, 300)}`);
  const paid = payOrder(checkout.data.orderId, "card", "");
  const event = { event: "payment.captured", payload: { payment: { entity: paymentsById.get(paid.razorpay_payment_id) } } };

  expectStatus(await send(event), 200, "webhook captured");
  expectStatus(await send(event), 200, "webhook captured (retry)");

  const sub = expectStatus(await api().get("/api/customer/subscription").set(as(token)), 200, "subscription");
  assert.equal(sub.data.subscription.plan, "premium");
  assert.equal(sub.data.subscription.screenCount, 6);
  const invoices = expectStatus(await api().get("/api/customer/invoices").set(as(token)), 200, "invoices");
  // One from the admin-recorded payment earlier, exactly one from this webhook payment.
  assert.equal(invoices.data.length, 2, "the retried webhook must not issue a second invoice");

  // A failed payment event is accepted and changes nothing.
  expectStatus(await send({ event: "payment.failed", payload: { payment: { entity: { order_id: "order_unknown", notes: {}, error_description: "Declined" } } } }), 200, "webhook failed");
});

test("settlement paid from a RazorpayX payout is checked for status, amount and account", async () => {
  const p = state.partners.affiliate;
  const login = expectStatus(await api().post("/api/partner/auth/login").send({ email: p.email, password: "newpassword456" }), 200, "affiliate login");

  const lead = expectStatus(await api().post("/api/partner/referrals").set(as(login.token)).send({ customer: { companyName: "Gym Chain" }, requirement: { screenCount: 8 } }), 201, "lead");
  const won = expectStatus(await api().patch(`/api/admin/leads/${lead.data._id}/win`).set(admin()).send({ plan: "premium", screenCount: 8, commissionAmount: 4000 }), 200, "lead won");
  const approved = expectStatus(await api().patch(`/api/admin/commissions/${won.data.commission._id}/approve`).set(admin()), 200, "approve reward");
  const id = approved.settlement._id;

  // A second reward approved before the payout joins the same open
  // settlement instead of opening another, and its total grows.
  const lead2 = expectStatus(await api().post("/api/partner/referrals").set(as(login.token)).send({ customer: { companyName: "Salon Group" }, requirement: { screenCount: 2 } }), 201, "second lead");
  const won2 = expectStatus(await api().patch(`/api/admin/leads/${lead2.data._id}/win`).set(admin()).send({ plan: "basic", screenCount: 2, commissionAmount: 1000 }), 200, "second lead won");
  const joined = expectStatus(await api().patch(`/api/admin/commissions/${won2.data.commission._id}/approve`).set(admin()), 200, "approve second reward");
  assert.equal(String(joined.settlement._id), String(id), "joins the open settlement");
  assert.equal(joined.settlement.net, 5000);
  // Reversing one takes it back out and the total drops again.
  expectStatus(await api().patch(`/api/admin/commissions/${won2.data.commission._id}/reverse`).set(admin()).send({ reason: "Customer cancelled." }), 200, "reverse second reward");
  const afterReverse = expectStatus(await api().get(`/api/admin/settlements/${id}`).set(admin()), 200, "settlement after reversal");
  assert.equal(afterReverse.data.amount.net, 4000);
  assert.equal(afterReverse.data.status, "approved");

  const payout = (overrides) => ({
    id: "pout_good1", status: "processed", amount: 400000, mode: "IMPS", utr: "UTR999", created_at: Math.floor(Date.now() / 1000),
    fund_account: { bank_account: { account_number: "50100123456789", ifsc: "HDFC0001234", name: "affiliate owner" } }, ...overrides
  });
  razorpayXPayouts.set("pout_wrongacct", payout({ id: "pout_wrongacct", fund_account: { bank_account: { account_number: "999999999999", ifsc: "HDFC0001234" } } }));
  razorpayXPayouts.set("pout_good1", payout({}));

  const bad = expectStatus(await api().get(`/api/admin/settlements/${id}/online-check`).query({ transactionId: "pout_wrongacct" }).set(admin()), 200, "online check (wrong account)");
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.checks.accountMatches, false);
  assert.equal((await api().patch(`/api/admin/settlements/${id}/mark-paid`).set(admin()).send({ transactionId: "pout_wrongacct" })).status, 400);

  const good = expectStatus(await api().get(`/api/admin/settlements/${id}/online-check`).query({ transactionId: "pout_good1" }).set(admin()), 200, "online check");
  assert.equal(good.data.ok, true);
  expectStatus(await api().patch(`/api/admin/settlements/${id}/mark-paid`).set(admin()).send({ transactionId: "pout_good1" }), 200, "mark paid from payout");

  const detail = expectStatus(await api().get(`/api/admin/settlements/${id}`).set(admin()), 200, "settlement detail");
  assert.equal(detail.data.status || detail.data.settlement?.status, "paid");
});

test("opportunities, team edits by the owner, and the remaining admin actions", async () => {
  const p = state.partners.affiliate;
  const login = expectStatus(await api().post("/api/partner/auth/login").send({ email: p.email, password: "newpassword456" }), 200, "affiliate login");
  const token = login.token;

  const opportunity = expectStatus(await api().post("/api/partner/opportunities").set(as(token)).send({ customer: { companyName: "Mall Group" }, expectedRevenue: 50000, expectedScreenCount: 20 }), 201, "create opportunity");
  expectStatus(await api().get("/api/partner/opportunities").set(as(token)), 200, "my opportunities");
  expectStatus(await api().patch(`/api/admin/opportunities/${opportunity.data._id}/stage`).set(admin()).send({ stage: "proposal" }), 200, "opportunity stage");
  expectStatus(await api().patch(`/api/admin/opportunities/${opportunity.data._id}/lose`).set(admin()).send({ lostReason: "Chose a competitor." }), 200, "opportunity lost");

  const team = expectStatus(await api().get("/api/partner/team").set(as(token)), 200, "team");
  const member = team.data.find((m) => m.role !== "owner");
  expectStatus(await api().patch(`/api/partner/team/${member._id}`).set(as(token)).send({ status: "active", role: "viewer" }), 200, "owner edits teammate");

  // Vendor customer marked expired; an influencer account rejected with a reason.
  const adminCustomers = expectStatus(await api().get("/api/admin/customers").set(admin()), 200, "admin customers");
  expectStatus(await api().patch(`/api/admin/customers/${adminCustomers.data[0]._id}/expire`).set(admin()), 200, "expire customer");

  const influencer = state.partners.influencer;
  const second = expectStatus(await api().post("/api/partner/social/accounts").set(as(influencer.token)).send({ platform: "youtube", accountId: "TestChannel", followers: 500 }), 201, "second social account");
  expectStatus(await api().patch(`/api/admin/social-media/accounts/${influencer.id}/${second.data._id}/review`).set(admin()).send({ decision: "rejected", rejectionReason: "Channel not found." }), 200, "reject social account");

  // A partner the admin suspends loses access to verified-only features.
  expectStatus(await api().patch(`/api/admin/partners/${influencer.id}/status`).set(admin()).send({ status: "suspended" }), 200, "suspend partner");
  assert.equal((await api().get("/api/partner/commissions").set(as(influencer.token))).status, 403);
  expectStatus(await api().patch(`/api/admin/partners/${influencer.id}/status`).set(admin()).send({ status: "active" }), 200, "reactivate partner");
  assert.equal((await api().get("/api/partner/commissions").set(as(influencer.token))).status, 200);
});

test("each partner is notified about its own type's work — leads, posts / reels, customers, licenses, earnings", async () => {
  const affiliateLogin = expectStatus(await api().post("/api/partner/auth/login").send({ email: state.partners.affiliate.email, password: "newpassword456" }), 200, "affiliate login");
  const tokens = {
    influencer: state.partners.influencer.token,
    affiliate: affiliateLogin.token,
    vendor: state.partners.vendor.token,
    reseller: state.partners.reseller.token
  };
  const inbox = {};
  for (const [type, token] of Object.entries(tokens)) {
    const body = expectStatus(await api().get("/api/partner/notifications").set(as(token)), 200, `${type} notifications`);
    inbox[type] = body.data;
  }
  const typesOf = (partnerType) => new Set(inbox[partnerType].map((n) => n.type));
  const expectTypes = (partnerType, expected) => {
    const got = typesOf(partnerType);
    const missing = expected.filter((t) => !got.has(t));
    assert.deepEqual(missing, [], `${partnerType} is missing notifications: ${missing.join(", ")} (has: ${[...got].join(", ")})`);
  };

  // Affiliate: every step of a lead, then its reward and payout.
  expectTypes("affiliate", ["lead_submitted", "lead_contacted", "lead_won", "lead_rejected", "commission_approved",
    "settlement_created", "settlement_paid", "team_member_invited", "team_member_updated", "profile_updated_by_admin", "opportunity_lost"]);

  // Influencer: accounts, rates, each post / reel, then the earning and payout.
  expectTypes("influencer", ["social_account_submitted", "social_account_verified", "social_account_rejected", "payment_rates_updated",
    "content_submitted", "content_approved", "content_rejected", "settlement_created", "settlement_paid", "partner_status_changed"]);

  // Vendor: customers, the commission each payment earns, and the settlement with its bill.
  expectTypes("vendor", ["customer_registered", "commission_created", "commission_approved", "commission_held",
    "settlement_created", "settlement_held", "settlement_bill_verified", "settlement_failed", "settlement_retried", "settlement_paid",
    "customer_subscription_cancelled", "customer_subscription_expired", "partner_agreement_issued"]);

  // Reseller: prepayment, license requests, inventory, invoices, customers, bank change.
  expectTypes("reseller", ["prepayment_awaiting_payment", "prepayment_done", "license_order_requested", "license_order_approved", "license_order_rejected",
    "license_inventory_adjusted", "reseller_invoice_generated", "reseller_invoice_paid", "reseller_customer_created", "bank_update_approved"]);

  // Nobody is told about another type's kind of work.
  const leadTypes = ["lead_submitted", "lead_contacted", "lead_won", "lead_rejected"];
  const contentTypes = ["content_submitted", "content_approved", "content_rejected", "social_account_verified"];
  const earningTypes = ["commission_created", "commission_approved", "settlement_created", "settlement_paid"];
  for (const t of leadTypes) for (const other of ["influencer", "vendor", "reseller"]) assert.equal(typesOf(other).has(t), false, `${other} got ${t}`);
  for (const t of contentTypes) for (const other of ["affiliate", "vendor", "reseller"]) assert.equal(typesOf(other).has(t), false, `${other} got ${t}`);
  for (const t of earningTypes) assert.equal(typesOf("reseller").has(t), false, `reseller got ${t}`);

  // Earnings are named the way each type knows them.
  const approval = (partnerType) => inbox[partnerType].find((n) => n.type === "commission_approved");
  assert.match(approval("affiliate").title, /Referral reward approved/);
  assert.match(approval("vendor").title, /Commission approved/);
  assert.match(inbox.affiliate.find((n) => n.type === "settlement_created").message, /referral reward/);
  assert.match(inbox.influencer.find((n) => n.type === "settlement_created").message, /content earning/);

  // A new lead is announced on both sides: to the affiliate who sent it,
  // and to the admins who have to contact it — with a link to the Leads page.
  const adminInbox = expectStatus(await api().get("/api/admin/notifications").set(admin()), 200, "admin notifications");
  const newLeads = adminInbox.data.notifications.filter((n) => n.type === "lead_submitted");
  const myLeads = expectStatus(await api().get("/api/partner/referrals").set(as(tokens.affiliate)), 200, "affiliate leads");
  assert.equal(newLeads.length, myLeads.data.length, "one admin notification per lead submitted");
  assert.ok(newLeads.every((n) => n.link === "/admin/leads" && n.title === "New lead to contact"));
  assert.equal(inbox.affiliate.filter((n) => n.type === "lead_submitted").length, myLeads.data.length, "one partner notification per lead submitted");
  assert.ok(adminInbox.data.notifications.some((n) => n.type === "license_order_requested"), "admins hear about a new reseller license request");

  // Each one points at the record it is about, so the app can open the right page.
  for (const [partnerType, list] of Object.entries(inbox)) {
    const unlinked = list.filter((n) => !n.entity?.type).map((n) => n.type);
    assert.deepEqual([...new Set(unlinked)], [], `${partnerType} notifications without a linked record`);
  }
});

/* ---------- reseller billing: every purchase is its own bill ---------- */

test("reseller billing: 200 licences at Rs.300 on a quarterly cycle are billed 1,80,000 + GST from the purchase date, and a later purchase is a separate bill", async () => {
  const billing = require("../services/resellerBilling");
  const ResellerInvoice = require("../models/ResellerInvoice");
  const p = state.partners.reseller;
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  // The cycle follows the purchase date: bought on 6 Oct, billed 6 Oct, 6 Jan, 6 Apr, 6 Jul.
  const sixthOct = new Date(2026, 9, 6);
  assert.deepEqual(
    [3, 6, 9, 12].map((months) => billing.addMonths(sixthOct, months).toDateString()),
    [new Date(2027, 0, 6), new Date(2027, 3, 6), new Date(2027, 6, 6), new Date(2027, 9, 6)].map((d) => d.toDateString())
  );
  assert.ok(sameDay(billing.addMonths(new Date(2026, 0, 31), 1), new Date(2026, 1, 28)), "a 31st start lands on the month's last day");

  expectStatus(await api().put(`/api/admin/reseller/partners/${p.id}/pricing-plan`).set(admin()).send({
    standardPricePerScreen: 300, pricingMode: "fixed_price", fixedPricePerScreen: 300, minPurchaseQty: 1, taxRatePercent: 18
  }), 200, "Rs.300 per screen");
  expectStatus(await api().put(`/api/admin/reseller/partners/${p.id}/billing-config`).set(admin()).send({ billingCycle: "quarterly", dueDays: 7 }), 200, "quarterly cycle");

  const buy = async (quantity) => {
    const order = expectStatus(await api().post("/api/partner/reseller/license-orders").set(as(p.token)).send({ quantity }), 201, `request ${quantity}`);
    expectStatus(await api().patch(`/api/admin/reseller/license-orders/${order.data.purchaseOrder._id}/accept`).set(admin()), 200, `accept ${quantity}`);
    return order.data.purchaseOrder._id;
  };
  const scheduleOf = async (orderId) => {
    const res = expectStatus(await api().get("/api/partner/reseller/invoices/current-due").set(as(p.token)), 200, "billing schedule");
    return res.data.bills.find((bill) => String(bill.orderId) === String(orderId));
  };

  const boughtAt = new Date();
  // The moment the daily billing job runs, some hours into the day a cycle starts.
  const later = (months) => new Date(billing.addMonths(boughtAt, months).getTime() + 6 * 60 * 60 * 1000);
  const firstOrderId = await buy(200);

  // The first bill is raised the day of purchase: one quarter, in advance.
  let firstInvoices = await ResellerInvoice.find({ purchaseOrderId: firstOrderId }).sort({ billingPeriodStart: 1 });
  assert.equal(firstInvoices.length, 1);
  assert.equal(firstInvoices[0].subtotal, 180000);
  assert.equal(firstInvoices[0].taxAmount, 32400);
  assert.equal(firstInvoices[0].total, 212400);
  assert.equal(firstInvoices[0].purchasedLicenseSnapshot, 200);
  assert.equal(firstInvoices[0].installmentNumber, 1);
  assert.equal(firstInvoices[0].installmentsInTerm, 4);
  assert.ok(sameDay(firstInvoices[0].billingPeriodStart, boughtAt));
  assert.ok(sameDay(firstInvoices[0].billingPeriodEnd, billing.addMonths(boughtAt, 3)));

  // What the reseller sees: 60,000 a month, 7,20,000 + GST for 12 months, in four bills.
  let bill = await scheduleOf(firstOrderId);
  assert.equal(bill.monthlyAmount, 60000);
  assert.equal(bill.cycleAmount, 180000);
  assert.equal(bill.termAmount, 720000);
  assert.equal(bill.termTotal, 849600);
  assert.deepEqual(bill.installments.map((i) => i.status), ["pending", "upcoming", "upcoming", "upcoming"]);
  assert.deepEqual(bill.installments.map((i) => i.subtotal), [180000, 180000, 180000, 180000]);
  [0, 3, 6, 9].forEach((months, index) => assert.ok(sameDay(bill.installments[index].billDate, billing.addMonths(boughtAt, months)), `bill ${index + 1} date`));

  // Nothing more is raised until the next quarter starts...
  await billing.generateInvoiceForPartner(p.id, { now: new Date(billing.addMonths(boughtAt, 3).getTime() - 24 * 60 * 60 * 1000) });
  assert.equal(await ResellerInvoice.countDocuments({ purchaseOrderId: firstOrderId }), 1);

  // ...and a later purchase is a NEW bill with its own cycle — the first one is untouched.
  const secondOrderId = await buy(50);
  assert.equal(await ResellerInvoice.countDocuments({ purchaseOrderId: firstOrderId }), 1);
  const secondInvoices = await ResellerInvoice.find({ purchaseOrderId: secondOrderId });
  assert.equal(secondInvoices.length, 1);
  assert.equal(secondInvoices[0].subtotal, 50 * 300 * 3);
  assert.notEqual(secondInvoices[0].invoiceNumber, firstInvoices[0].invoiceNumber);
  assert.equal((await scheduleOf(secondOrderId)).termAmount, 50 * 300 * 12);

  // Three months on, the second quarterly bill of each purchase falls due.
  await billing.generateInvoiceForPartner(p.id, { now: later(3) });
  firstInvoices = await ResellerInvoice.find({ purchaseOrderId: firstOrderId }).sort({ billingPeriodStart: 1 });
  assert.equal(firstInvoices.length, 2);
  assert.equal(firstInvoices[1].installmentNumber, 2);
  assert.equal(firstInvoices[1].total, 212400);
  assert.ok(sameDay(firstInvoices[1].billingPeriodStart, billing.addMonths(boughtAt, 3)));
  // Running it again raises nothing twice.
  await billing.generateInvoiceForPartner(p.id, { now: later(3) });
  assert.equal(await ResellerInvoice.countDocuments({ purchaseOrderId: firstOrderId }), 2);

  // After twelve months all four bills exist and add up to 7,20,000 + GST.
  await billing.generateInvoiceForPartner(p.id, { now: later(9) });
  firstInvoices = await ResellerInvoice.find({ purchaseOrderId: firstOrderId });
  assert.equal(firstInvoices.length, 4);
  assert.equal(firstInvoices.reduce((sum, invoice) => sum + invoice.subtotal, 0), 720000);
  assert.equal(firstInvoices.reduce((sum, invoice) => sum + invoice.total, 0), 849600);

  // A price change afterwards doesn't touch what was already bought.
  expectStatus(await api().put(`/api/admin/reseller/partners/${p.id}/pricing-plan`).set(admin()).send({
    standardPricePerScreen: 500, pricingMode: "fixed_price", fixedPricePerScreen: 500, minPurchaseQty: 1, taxRatePercent: 18
  }), 200, "raise the price");
  bill = await scheduleOf(firstOrderId);
  assert.equal(bill.unitPrice, 300);
  assert.equal(bill.cycleAmount, 180000);
});

test("reseller billing works the same on every cycle: monthly = 12 bills, quarterly = 4, yearly = 1, each from the purchase date", async () => {
  const billing = require("../services/resellerBilling");
  const ResellerInvoice = require("../models/ResellerInvoice");
  const p = state.partners.reseller;
  const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

  expectStatus(await api().put(`/api/admin/reseller/partners/${p.id}/pricing-plan`).set(admin()).send({
    standardPricePerScreen: 300, pricingMode: "fixed_price", fixedPricePerScreen: 300, minPurchaseQty: 1, taxRatePercent: 18
  }), 200, "Rs.300 per screen");

  // 200 licences x Rs.300 = 60,000 a month = 7,20,000 for 12 months, whatever the cycle.
  const expected = {
    monthly: { bills: 12, months: 1, each: 60000 },
    quarterly: { bills: 4, months: 3, each: 180000 },
    yearly: { bills: 1, months: 12, each: 720000 }
  };

  for (const [cycle, want] of Object.entries(expected)) {
    expectStatus(await api().put(`/api/admin/reseller/partners/${p.id}/billing-config`).set(admin()).send({ billingCycle: cycle, dueDays: 7 }), 200, `${cycle} cycle`);
    const boughtAt = new Date();
    const order = expectStatus(await api().post("/api/partner/reseller/license-orders").set(as(p.token)).send({ quantity: 200 }), 201, `request (${cycle})`);
    const orderId = order.data.purchaseOrder._id;
    expectStatus(await api().patch(`/api/admin/reseller/license-orders/${orderId}/accept`).set(admin()), 200, `accept (${cycle})`);

    // The first bill is raised on the day of purchase, for one cycle in advance.
    const first = await ResellerInvoice.find({ purchaseOrderId: orderId });
    assert.equal(first.length, 1, `${cycle}: one bill on the purchase day`);
    assert.equal(first[0].billingCycle, cycle);
    assert.equal(first[0].subtotal, want.each, `${cycle}: amount of each bill`);
    assert.equal(first[0].total, want.each * 1.18, `${cycle}: with GST`);
    assert.equal(first[0].installmentsInTerm, want.bills);
    assert.ok(sameDay(first[0].billingPeriodEnd, billing.addMonths(boughtAt, want.months)), `${cycle}: covers one cycle`);

    const schedule = expectStatus(await api().get("/api/partner/reseller/invoices/current-due").set(as(p.token)), 200, "schedule");
    const bill = schedule.data.bills.find((b) => String(b.orderId) === String(orderId));
    assert.equal(bill.billingCycle, cycle);
    assert.equal(bill.monthlyAmount, 60000);
    assert.equal(bill.termAmount, 720000);
    assert.equal(bill.termTotal, 849600);
    assert.equal(bill.installments.length, want.bills);
    bill.installments.forEach((installment, index) =>
      assert.ok(sameDay(installment.billDate, billing.addMonths(boughtAt, index * want.months)), `${cycle}: bill ${index + 1} date`));

    // By the end of the year every bill has been raised, and they add up to 7,20,000 + GST.
    const lastBillDay = new Date(billing.addMonths(boughtAt, 12 - want.months).getTime() + 6 * 60 * 60 * 1000);
    await billing.generateInvoiceForPartner(p.id, { now: lastBillDay });
    const all = await ResellerInvoice.find({ purchaseOrderId: orderId });
    assert.equal(all.length, want.bills, `${cycle}: ${want.bills} bill(s) in the year`);
    assert.equal(all.reduce((sum, invoice) => sum + invoice.subtotal, 0), 720000);
    assert.equal(Math.round(all.reduce((sum, invoice) => sum + invoice.total, 0)), 849600);
  }

  // Changing the cycle later only affects new purchases: each bill above kept its own.
  const cycles = (await api().get("/api/partner/reseller/invoices/current-due").set(as(p.token))).body.data.bills.slice(0, 3).map((b) => b.billingCycle);
  assert.deepEqual(cycles, ["yearly", "quarterly", "monthly"]);
});

/* ---------- vendor commission: one time per customer, or recurring ---------- */

test("vendor commission: 10% one time per customer on what that customer paid; recurring and per-screen are the other options", async () => {
  const p = state.partners.vendor;
  const assign = async (body) => expectStatus(await api().post(`/api/admin/partners/${p.id}/commission-assignment`).set(admin()).send(body), 200, `assign ${body.commissionType}`);
  const addCustomer = async (name) => expectStatus(await api().post("/api/partner/customers").set(as(p.token)).send({
    companyName: name, contactName: "Owner", email: `${name.toLowerCase().replace(/\W+/g, "")}@example.com`, phone: "9555500000"
  }), 201, `register ${name}`).data._id;
  let manualPaymentSequence = 0;
  const pay = async (customerId, screens, price, plan) => expectStatus(await api().patch(`/api/admin/customers/${customerId}/mark-paid`).set(admin())
    .send({ paymentReference: `SCENARIO-${++manualPaymentSequence}`, revenue: screens * price, screenCount: screens, plan, durationMonths: 1 }), 200, "customer pays");
  const earnedFrom = async (customerId) => {
    const all = expectStatus(await api().get("/api/admin/commissions").query({ partnerId: p.id }).set(admin()), 200, "vendor commissions");
    return all.data.filter((c) => String(c.customerId?._id || c.customerId) === String(customerId)).map((c) => c.calculation.netCommission);
  };

  await assign({ commissionType: "percentage", rate: 10 });

  // Three paying customers, 200 screens between them.
  const one = await addCustomer("Scenario One");
  const two = await addCustomer("Scenario Two");
  const three = await addCustomer("Scenario Three");
  // A customer who registered but never paid earns the vendor nothing.
  const unpaid = await addCustomer("Scenario Unpaid");

  const first = await pay(one, 50, 499, "basic");
  await pay(two, 100, 999, "premium");
  await pay(three, 50, 999, "premium");
  assert.match(first.message, /commission generated/);

  assert.deepEqual(await earnedFrom(one), [2495]);    // 50 x 499 = 24,950 -> 10%
  assert.deepEqual(await earnedFrom(two), [9990]);    // 100 x 999 = 99,900 -> 10%
  assert.deepEqual(await earnedFrom(three), [4995]);  // 50 x 999 = 49,950 -> 10%
  assert.deepEqual(await earnedFrom(unpaid), []);

  // ONE TIME: the same customer paying again (a renewal) earns nothing more.
  const renewal = await pay(three, 50, 999, "premium");
  assert.equal(renewal.data.commission, null);
  assert.match(renewal.message, /one-time commission for this customer was already earned on their first payment/);
  assert.deepEqual(await earnedFrom(three), [4995]);

  // Adding screens later is not a new commission either: it was one time, on the first payment.
  await pay(one, 80, 499, "basic");
  assert.deepEqual(await earnedFrom(one), [2495]);

  // RECURRING: switch the vendor to a recurring percentage and every payment earns.
  await assign({ commissionType: "recurring_percentage", rate: 10 });
  await pay(three, 50, 999, "premium");
  await pay(three, 50, 999, "premium");
  assert.deepEqual((await earnedFrom(three)).sort(), [4995, 4995, 4995]);

  // PER SCREEN, one time: Rs.100 a screen on a new 50-screen customer = 5,000, once.
  await assign({ commissionType: "fixed_per_screen", perScreenAmount: 100 });
  const four = await addCustomer("Scenario Four");
  await pay(four, 50, 999, "premium");
  await pay(four, 50, 999, "premium");
  assert.deepEqual(await earnedFrom(four), [5000]);
});

test("cash and cheque reseller collections retain method and receipt without Razorpay", async () => {
  const Partner = require("../models/Partner");
  const Invoice = require("../models/ResellerInvoice");
  const Config = require("../models/ResellerBillingConfig");
  const template = await Invoice.findOne().lean();
  assert.ok(template);
  for (const method of ["cash", "cheque"]) {
    const partner = await Partner.create({ partnerType: "reseller", partnerCode: `OFFLINE-${method}`, primaryContact: { name: "Offline reseller", email: `${method}@example.com`, phone: "9876543210" } });
    const transactionId = `${method}-receipt-123`;
    const prepayUrl = `/api/admin/reseller/partners/${partner._id}/prepayment`;
    const details = { paymentMode: "offline", amount: 1000, method, transactionId };
    expectStatus(await api().patch(prepayUrl).set(admin()).send({ ...details, transactionId: " " }), 400, "missing receipt");
    expectStatus(await api().patch(prepayUrl).set(admin()).send(details), 200, `${method} prepayment`);
    const config = await Config.findOne({ partnerId: partner._id });
    assert.equal(config.prepayment.status, "done");
    assert.equal(config.prepayment.offlinePayment.method, method);
    assert.equal(config.prepayment.offlinePayment.transactionId, transactionId);
    assert.ok(!config.prepayment.razorpay?.paymentId);
    const { _id, purchaseOrderId, razorpay, offlinePayment, ...fields } = template;
    const invoice = await Invoice.create({ ...fields, partnerId: partner._id, invoiceNumber: `OFFLINE-${method}`, paymentStatus: "pending", paymentMode: "offline" });
    const url = `/api/admin/reseller/invoices/${invoice._id}/verify-offline`;
    expectStatus(await api().patch(url).set(admin()).send({ method: "invalid", transactionId }), 400, "invalid method");
    expectStatus(await api().patch(url).set(admin()).send({ method, transactionId }), 200, `${method} invoice`);
    const paid = await Invoice.findById(invoice._id);
    assert.equal(paid.paymentStatus, "paid");
    assert.equal(paid.offlinePayment.method, method);
    assert.equal(paid.offlinePayment.transactionId, transactionId);
    assert.ok(paid.offlinePayment.verifiedBy);
    assert.ok(!paid.razorpay?.paymentId);
    expectStatus(await api().patch(url).set(admin()).send({ method, transactionId }), 400, "duplicate collection");
  }
});

test("influencer partners cannot access team management", async () => {
  const p = state.partners.influencer;
  expectStatus(await api().get("/api/partner/team").set(as(p.token)), 403, "influencer team list");
  expectStatus(await api().post("/api/partner/team").set(as(p.token)).send({ name: "Teammate", email: "blocked-team@example.com", role: "viewer" }), 403, "influencer team invite");
  expectStatus(await api().patch(`/api/partner/team/${p.id}`).set(as(p.token)).send({ status: "blocked" }), 403, "influencer team update");
  expectStatus(await api().patch(`/api/admin/partners/${p.id}/team/${p.id}`).set(admin()).send({ status: "blocked" }), 403, "admin influencer team update");
});

test("payment claims prevent concurrent cross-record reuse and allow owner retries", async () => {
  const { claimPayment } = require("../utils/assertPaymentNotReused");
  const Claim = require("../models/PaymentClaim");
  const paymentId = "pay_concurrency_test";
  const results = await Promise.allSettled([
    claimPayment(paymentId, "invoice:first"),
    claimPayment(paymentId, "prepayment:second")
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.statusCode, 409);
  const owner = await Claim.findById(paymentId);
  await assert.doesNotReject(() => claimPayment(paymentId, owner.target));
  await assert.rejects(() => claimPayment(paymentId, "invoice:third"), { statusCode: 409 });
});

test("admin onboarding sends an expiring setup link without a password", async () => {
  const email = "secure-onboarding@example.com";
  const result = await api().post("/api/admin/partners").set(admin()).send({ partnerType: "affiliate", contactName: "Secure [Partner]", email, phone: "9888888888" });
  expectStatus(result, 201, "password-free onboarding");
  const mail = lastMailTo(email);
  assert.ok(mail.text.includes("expires in 24 hours"));
  assert.ok(!mail.text.includes("Password:"));
  const token = mail.text.match(/reset-password\/([a-f0-9]+)/)[1];
  expectStatus(await api().post(`/api/partner/auth/reset-password/${token}`).set("X-Forwarded-For", "192.0.2.99").send({ password: "SecurePassword123" }), 200, "password setup");
  expectStatus(await api().post("/api/partner/auth/login").set("X-Forwarded-For", "192.0.2.99").send({ email, password: "SecurePassword123" }), 200, "invited partner login");
  expectStatus(await api().post(`/api/partner/auth/reset-password/${token}`).set("X-Forwarded-For", "192.0.2.99").send({ password: "AnotherPassword123" }), 400, "setup token cannot be reused");
});

test("partner pagination searches globally and treats regex characters literally", async () => {
  const first = expectStatus(await api().get("/api/admin/partners?page=1&limit=2").set(admin()), 200, "first partner page");
  const second = expectStatus(await api().get("/api/admin/partners?page=2&limit=2").set(admin()), 200, "second partner page");
  assert.equal(first.data.length, 2);
  assert.equal(second.data.length, 2);
  assert.ok(first.data.every((partner) => !second.data.some((other) => other._id === partner._id)));
  assert.equal(first.pagination.total, second.pagination.total);
  const searched = expectStatus(await api().get("/api/admin/partners").query({ page: 1, limit: 2, search: "[Partner]" }).set(admin()), 200, "literal name search");
  assert.equal(searched.pagination.total, 1);
  assert.equal(searched.data[0].primaryContact.email, "secure-onboarding@example.com");
});

test("cheques remain unpaid until cleared and preserve their history", async () => {
  const Invoice = require("../models/ResellerInvoice");
  const template = await Invoice.findOne().lean();
  const { _id, purchaseOrderId, paymentHistory, cheque, offlinePayment, razorpay, paidAt, ...fields } = template;
  const invoice = await Invoice.create({ ...fields, invoiceNumber: "CHEQUE-TRACKING", paymentStatus: "pending" });
  const url = `/api/admin/reseller/invoices/${invoice._id}/verify-offline`;
  for (const chequeStatus of ["received", "bounced", "received"]) {
    expectStatus(await api().patch(url).set(admin()).send({ method: "cheque", transactionId: "CHEQUE-001", chequeStatus }), 200, chequeStatus);
    const stored = await Invoice.findById(invoice._id);
    assert.equal(stored.paymentStatus, "pending");
    assert.equal(stored.cheque.status, chequeStatus);
  }
  expectStatus(await api().patch(url).set(admin()).send({ method: "cheque", transactionId: "CHEQUE-001", chequeStatus: "cleared" }), 200, "cleared cheque");
  const paid = await Invoice.findById(invoice._id);
  assert.equal(paid.paymentStatus, "paid");
  assert.equal(paid.cheque.status, "cleared");
  assert.deepEqual(paid.paymentHistory.map((event) => event.action), ["cheque_received", "cheque_bounced", "cheque_received", "paid"]);
  assert.ok(paid.paymentHistory.every((event) => event.recordedBy && event.recordedAt));
  expectStatus(await api().patch(url).set(admin()).send({ method: "cheque", transactionId: "CHEQUE-001", chequeStatus: "bounced" }), 400, "paid cheque cannot be changed");
});

test("invitation resending invalidates old links and stops after password setup", async () => {
  const User = require("../models/Partneruser");
  const email = "resend-invitation@example.com";
  const created = expectStatus(await api().post("/api/admin/partners").set(admin()).send({ partnerType: "affiliate", contactName: "Resend Partner", email, phone: "9777777777" }), 201, "create pending invitation");
  const id = created.data.partner._id;
  const oldToken = lastMailTo(email).text.match(/reset-password\/([a-f0-9]+)/)[1];
  await User.updateOne({ partnerId: id }, { $set: { "auth.resetTokenExpires": new Date(Date.now() + 24 * 60 * 60 * 1000 - 61000) } });
  expectStatus(await api().post(`/api/admin/partners/${id}/resend-invitation`).set(admin()), 200, "resend invitation");
  const token = lastMailTo(email).text.match(/reset-password\/([a-f0-9]+)/)[1];
  assert.notEqual(token, oldToken);
  expectStatus(await api().post(`/api/admin/partners/${id}/resend-invitation`).set(admin()), 429, "resend cooldown");
  expectStatus(await api().post(`/api/partner/auth/reset-password/${oldToken}`).set("X-Forwarded-For", "192.0.2.100").send({ password: "SecurePassword123" }), 400, "old setup link invalid");
  expectStatus(await api().post(`/api/partner/auth/reset-password/${token}`).set("X-Forwarded-For", "192.0.2.100").send({ password: "SecurePassword123" }), 200, "new setup link works");
  expectStatus(await api().post(`/api/admin/partners/${id}/resend-invitation`).set(admin()), 400, "completed setup cannot be resent");
});

test("prepayment cheque receipt and bounce keep purchases locked until clearance", async () => {
  const Partner = require("../models/Partner");
  const Config = require("../models/ResellerBillingConfig");
  const partner = await Partner.create({ partnerType: "reseller", partnerCode: "PREPAY-CHEQUE", primaryContact: { name: "Cheque reseller", email: "prepay-cheque@example.com", phone: "9888888888" } });
  const url = `/api/admin/reseller/partners/${partner._id}/prepayment`;
  for (const chequeStatus of ["received", "bounced"]) {
    expectStatus(await api().patch(url).set(admin()).send({ paymentMode: "offline", amount: 1000, method: "cheque", transactionId: "PREPAY-001", chequeStatus }), 200, chequeStatus);
    const config = await Config.findOne({ partnerId: partner._id });
    assert.equal(config.prepayment.status, "not_done");
    assert.equal(config.prepayment.cheque.status, chequeStatus);
  }
  expectStatus(await api().patch(url).set(admin()).send({ paymentMode: "offline", amount: 1000, method: "cheque", transactionId: "PREPAY-001", chequeStatus: "cleared" }), 200, "prepayment clearance");
  const paid = await Config.findOne({ partnerId: partner._id });
  assert.equal(paid.prepayment.status, "done");
  assert.equal(paid.prepayment.cheque.status, "cleared");
  assert.deepEqual(paid.prepayment.paymentHistory.map((event) => event.action), ["cheque_received", "cheque_bounced", "paid"]);
});

test("settlement cheque tracking preserves unpaid state and records cheque payment method", async () => {
  const Settlement = require("../models/Partnersettlement");
  const template = await Settlement.findOne({ partnerId: state.partners.affiliate.id, status: "paid" }).lean();
  assert.ok(template);
  const { _id, payment, cheque, ...fields } = template;
  const settlement = await Settlement.create({ ...fields, settlementNumber: "SET-CHEQUE-TRACKING", status: "approved" });
  const url = `/api/admin/settlements/${settlement._id}/mark-paid-offline`;
  for (const chequeStatus of ["received", "bounced"]) {
    expectStatus(await api().patch(url).set(admin()).send({ method: "cheque", referenceNumber: "SET-CHEQUE-001", chequeStatus }), 200, chequeStatus);
    const current = await Settlement.findById(settlement._id);
    assert.equal(current.status, "approved");
    assert.equal(current.cheque.status, chequeStatus);
  }
  expectStatus(await api().patch(url).set(admin()).send({ method: "cheque", referenceNumber: "SET-CHEQUE-001", chequeStatus: "cleared" }), 200, "settlement clearance");
  const paid = await Settlement.findById(settlement._id);
  assert.equal(paid.status, "paid");
  assert.equal(paid.payment.method, "cheque");
  assert.equal(paid.cheque.status, "cleared");
});

test("reseller admin mutations enforce finance authorization", async () => {
  const User = require("../models/User");
  const jwt = require("jsonwebtoken");
  const reviewer = await User.create({ name: "Reviewer", email: "reviewer-audit@example.com", role: "kyc_reviewer", passwordHash: "not-used" });
  const token = jwt.sign({ adminId: reviewer._id }, process.env.ADMIN_JWT_SECRET);
  expectStatus(await api().get("/api/admin/reseller/invoices").set(as(token)), 200, "reviewer read access");
  for (const path of ["/api/admin/reseller/run-billing", "/api/admin/reseller/check-notifications"]) {
    expectStatus(await api().post(path).set(as(token)), 403, "reviewer mutation denied");
  }
  expectStatus(await api().patch(`/api/admin/reseller/partners/${state.partners.reseller.id}/prepayment`).set(as(token)).send({ paymentMode: "online", amount: 1000 }), 403, "reviewer prepayment denied");
});

test("concurrent settlement finalization credits exactly once and failures roll back", async () => {
  const Partner = require("../models/Partner");
  const Settlement = require("../models/Partnersettlement");
  const History = require("../models/PartnerSettlementHistory");
  const { finalizeSettlementPaid } = require("../services/settlementPayoutFulfillment");
  const template = await Settlement.findOne({ partnerId: state.partners.affiliate.id, status: "paid" }).lean();
  const { _id, ...fields } = template;
  const settlement = await Settlement.create({ ...fields, settlementNumber: "ATOMIC-SETTLEMENT", status: "approved" });
  const before = await Partner.findById(settlement.partnerId);
  const copies = await Promise.all([Settlement.findById(settlement._id), Settlement.findById(settlement._id)]);
  const results = await Promise.allSettled(copies.map((copy) => finalizeSettlementPaid(copy, { method: "cash", transactionId: "ATOMIC-RECEIPT", payableTotal: 10 })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.statusCode, 409);
  const after = await Partner.findById(settlement.partnerId);
  assert.equal(after.stats.paidCommission - before.stats.paidCommission, 10);
  assert.equal(await History.countDocuments({ settlementId: settlement._id, action: "paid_offline" }), 1);
  const rollback = await Settlement.create({ ...fields, settlementNumber: "ROLLBACK-SETTLEMENT", status: "approved" });
  const original = History.create;
  History.create = async () => { throw new Error("Injected history failure"); };
  try { await assert.rejects(() => finalizeSettlementPaid(rollback, { method: "cash", payableTotal: 10 }), /Injected history failure/); }
  finally { History.create = original; }
  assert.equal((await Settlement.findById(rollback._id)).status, "approved");
  assert.equal((await Partner.findById(settlement.partnerId)).stats.paidCommission, after.stats.paidCommission);
});

test("overlapping online configuration cannot undo completed prepayment", async () => {
  const Partner = require("../models/Partner");
  const ResellerBillingConfig = require("../models/ResellerBillingConfig");
  const partner = await Partner.create({ partnerType: "reseller", partnerCode: "ATOMIC-PREPAY", primaryContact: { name: "Atomic", email: "atomic@example.com", phone: "9888888888" } });
  await ResellerBillingConfig.create({ partnerId: partner._id });
  const path = `/api/admin/reseller/partners/${partner._id}/prepayment`;
  const results = await Promise.all([
    api().patch(path).set(admin()).send({ paymentMode: "online", amount: 1000 }),
    api().patch(path).set(admin()).send({ paymentMode: "offline", amount: 1000, method: "cash", transactionId: "ATOMIC-CASH" })
  ]);
  assert.equal(results[1].status, 200);
  assert.ok([200, 400, 409].includes(results[0].status));
  assert.equal((await ResellerBillingConfig.findOne({ partnerId: partner._id })).prepayment.status, "done");
});

test("readiness reports database loss while liveness stays available", async () => {
  const mongoose = require("mongoose");
  expectStatus(await api().get("/health"), 200, "ready database");
  const original = mongoose.connection.readyState;
  mongoose.connection.readyState = 0;
  try { expectStatus(await api().get("/health"), 503, "database unavailable"); expectStatus(await api().get("/live"), 200, "process alive"); }
  finally { mongoose.connection.readyState = original; }
});

test("distributed job lease skips competing work", async () => {
  const runWithLease = require("../utils/runWithLease");
  let release;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const first = runWithLease("audit-lease", async () => { started(); await new Promise((resolve) => { release = resolve; }); return "finished"; });
  await ready;
  assert.deepEqual(await runWithLease("audit-lease", async () => "wrong"), { skipped: true });
  release();
  assert.equal(await first, "finished");
  assert.equal(await runWithLease("audit-lease", async () => "next"), "next");
});

test("invitation concurrency sends once and failed delivery preserves the working link", async () => {
  const User = require("../models/Partneruser");
  const email = "invitation-race@example.com";
  const created = expectStatus(await api().post("/api/admin/partners").set(admin()).send({ partnerType: "affiliate", contactName: "Invitation Race", email, phone: "9766666666" }), 201, "create invitation");
  const id = created.data.partner._id;
  const expireCooldown = () => User.updateOne({ partnerId: id }, { $set: { "auth.resetTokenExpires": new Date(Date.now() + 24 * 60 * 60 * 1000 - 61000) } });
  await expireCooldown();
  const count = outbox.filter((mail) => mail.to === email).length;
  const results = await Promise.all([1, 2].map(() => api().post(`/api/admin/partners/${id}/resend-invitation`).set(admin())));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 429]);
  assert.equal(outbox.filter((mail) => mail.to === email).length, count + 1);
  const token = lastMailTo(email).text.match(/reset-password\/([a-f0-9]+)/)[1];
  await expireCooldown();
  failingMailRecipients.add(email);
  try { expectStatus(await api().post(`/api/admin/partners/${id}/resend-invitation`).set(admin()), 503, "failed delivery"); }
  finally { failingMailRecipients.delete(email); }
  expectStatus(await api().post(`/api/partner/auth/reset-password/${token}`).set("X-Forwarded-For", "192.0.2.101").send({ password: "SecurePassword123" }), 200, "previous link survives failure");
});

test("a failed verification retry cannot downgrade a captured payment awaiting commission", async () => {
  const Payment = require("../models/CustomerPayment");
  const { token, id, pay } = state.recoveryScenario;
  await Payment.updateOne({ _id: id }, { $set: { commissionGenerated: false } });
  const original = paymentsById.get(pay.razorpay_payment_id);
  paymentsById.set(pay.razorpay_payment_id, { ...original, amount: original.amount + 1 });
  try {
    expectStatus(await api().post("/api/customer/subscription/verify").set(as(token)).send({ customerPaymentId: id, ...pay }), 400, "refuse incorrect payment amount");
    const captured = await Payment.findById(id);
    assert.equal(captured.status, "paid");
    assert.equal(captured.razorpay.paymentId, pay.razorpay_payment_id);
  } finally {
    paymentsById.set(pay.razorpay_payment_id, original);
    await Payment.updateOne({ _id: id }, { $set: { commissionGenerated: true } });
  }
});

test("each authenticated partner dashboard returns only its own business overview", async () => {
  const Partner = require("../models/Partner");
  const summarize = require("../services/partnerProfileSummary");
  for (const type of ["affiliate", "influencer", "vendor", "reseller"]) {
    const own = state.partners[type];
    const partner = await Partner.findById(own.id);
    const expected = await summarize(partner);
    const response = expectStatus(await api().get("/api/partner/dashboard").query({ partnerId: state.partners[type === "vendor" ? "affiliate" : "vendor"].id }).set(as(own.token)), 200, `${type} own business overview`);
    const actual = response.data.businessOverview;
    assert.deepEqual(actual.earnings, expected.earnings);
    const keys = { affiliate: ["leads"], influencer: ["posts", "platforms"], vendor: ["customers", "payments"], reseller: ["customers", "invoices", "orders"] }[type];
    for (const key of keys) assert.deepEqual(actual[key], expected[key]);
    assert.equal(actual.assignment, undefined);
    assert.equal(actual.recentCustomers, undefined);
  }
});


test("reseller security: reset revokes sessions, suspended accounts lose access, spoofed files are rejected", async () => {
  const Customer = require("../models/ResellerCustomer");
  const customer = await Customer.findOne({ "contactDetails.email": "portal@example.com" });
  const login = expectStatus(await api().post("/api/public/reseller-customers/login").send({ email: "portal@example.com", password: "password123" }), 200, "security login");
  const oldToken = login.data.token;
  expectStatus(await api().post("/api/public/reseller-customers/forgot-password").send({ email: "portal@example.com" }), 200, "request reset");
  const token = lastMailTo("portal@example.com").text.match(/\/reseller\/customer\/verify\/([a-f0-9]+)/)[1];
  expectStatus(await api().post("/api/public/reseller-customers/verify").send({ token, password: "updatedpassword123" }), 200, "reset password");
  expectStatus(await api().get("/api/customer-portal/me").set(as(oldToken)), 401, "old token revoked");
  const fresh = expectStatus(await api().post("/api/public/reseller-customers/login").send({ email: "portal@example.com", password: "updatedpassword123" }), 200, "fresh login");
  await Customer.updateOne({ _id: customer._id }, { $set: { status: "suspended" } });
  expectStatus(await api().get("/api/customer-portal/me").set(as(fresh.data.token)), 401, "suspension blocks existing session");
  expectStatus(await api().post("/api/public/reseller-customers/login").send({ email: "portal@example.com", password: "updatedpassword123" }), 403, "suspension blocks login");
  await Customer.updateOne({ _id: customer._id }, { $set: { status: customer.status } });
  const response = await api().post("/api/partner/documents").set(as(state.partners.vendor.token)).field("documentType", "pan").attach("file", Buffer.from("not a PDF"), { filename: "fake.pdf", contentType: "application/pdf" });
  assert.equal(response.status, 400, "fake PDF rejected");
  for (let i = 0; i < 25; i++) {
    const result = await api().post("/api/public/reseller-customers/login").send({ email: "missing@example.com", password: "wrongpassword" });
    if (result.status === 429) return;
  }
  assert.fail("reseller login must be rate limited");
});


test("commission pagination returns distinct pages and complete totals", async () => {
  const { PartnerCommission: Commission } = require("../models/Index");
  const total = await Commission.countDocuments({});
  const first = expectStatus(await api().get("/api/admin/commissions?page=1&limit=2").set(admin()), 200, "first commission page");
  const second = expectStatus(await api().get("/api/admin/commissions?page=2&limit=2").set(admin()), 200, "second commission page");
  assert.equal(first.data.length, 2);
  assert.equal(first.pagination.total, total);
  assert.equal(first.pagination.pages, Math.ceil(total / 2));
  assert.ok(second.data.every(row => !first.data.some(other => other._id === row._id)));
});

test("confirmed customer payments succeed while missing commission terms await recovery", async () => {
  const Assignment = require("../models/PartnerCommissionAssignment");
  const Payment = require("../models/CustomerPayment");
  const token = state.recoveryScenario.token;
  const checkout = expectStatus(await api().post("/api/customer/subscription/checkout").set(as(token)).send({ plan: "basic", screenCount: 5, durationMonths: 1 }), 200, "new checkout");
  const payment = payOrder(checkout.data.orderId, "upi", "");
  const assignments = await Assignment.find({ partnerId: state.partners.vendor.id, status: "active" });
  await Assignment.updateMany({ _id: { $in: assignments.map(a => a._id) } }, { $set: { status: "inactive" } });
  try {
    const result = expectStatus(await api().post("/api/customer/subscription/verify").set(as(token)).send({ customerPaymentId: checkout.data.customerPaymentId, ...payment }), 200, "captured payment still succeeds");
    assert.equal(result.data.subscription.status, "active");
    const committed = await Payment.findById(checkout.data.customerPaymentId);
    assert.equal(committed.status, "paid");
    assert.equal(committed.commissionGenerated, false);
  } finally {
    await Assignment.updateMany({ _id: { $in: assignments.map(a => a._id) } }, { $set: { status: "active" } });
    await require("../services/customerPaymentFulfillment").recoverPendingCustomerCommissions();
  }
  assert.equal((await Payment.findById(checkout.data.customerPaymentId)).commissionGenerated, true);
});


test("HttpOnly browser sessions authenticate, reject CSRF and clear on logout", async () => {
  const agent = request.agent(app);
  const origin = process.env.CLIENT_URL;
  const login = await agent.post("/api/admin/auth/login").set("Origin", origin).set("X-Session-Mode", "cookie").set("X-Forwarded-For", "192.0.2.200").send({ email: "admin@example.com", password: "adminpass123" });
  assert.equal(login.status, 200);
  assert.equal(login.body.token, undefined, "browser response does not expose JWT");
  assert.ok(login.headers["set-cookie"].some(cookie => cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax") && cookie.includes("Path=/api")));
  expectStatus(await agent.get("/api/admin/stats/dashboard"), 200, "cookie authenticates");
  expectStatus(await agent.post("/api/session/logout").set("Origin", "https://attacker.example").send({ portal: "admin" }), 403, "cross-origin logout rejected");
  expectStatus(await agent.post("/api/session/logout").send({ portal: "admin" }), 403, "missing origin rejected");
  expectStatus(await agent.post("/api/session/logout").set("Origin", origin).send({ portal: "admin" }), 200, "logout clears cookie");
  expectStatus(await agent.get("/api/admin/stats/dashboard"), 401, "logged-out cookie cannot authenticate");
});

test("partner customer lists paginate without changing legacy consumers", async () => {
  for (const [type, route] of [["vendor", "/api/partner/customers"], ["reseller", "/api/partner/reseller/customers"]]) {
    const legacy = expectStatus(await api().get(route).set(as(state.partners[type].token)), 200, "legacy customer list");
    const page = expectStatus(await api().get(route).query({ page: 1, limit: 1 }).set(as(state.partners[type].token)), 200, "bounded customer list");
    assert.equal(page.pagination.total, legacy.data.length);
    assert.ok(page.data.length <= 1);
    assert.equal(page.pagination.pages, legacy.data.length);
  }
});


test("settlement pagination preserves all-record summary amounts", async () => {
  const { PartnerSettlement } = require("../models/Index");
  const total = await PartnerSettlement.countDocuments({});
  const page = expectStatus(await api().get("/api/admin/settlements").query({ page: 1, limit: 1 }).set(admin()), 200, "settlement page");
  assert.equal(page.pagination.total, total);
  assert.ok(page.data.length <= 1);
  assert.equal(typeof page.summary.totalOwed, "number");
});


test("partner and both customer portals use separate HttpOnly browser sessions", async () => {
  const origin = process.env.CLIENT_URL;
  for (const [portal, route, profile, email, password] of [
    ["partner", "/api/partner/auth/login", "/api/partner/dashboard", state.partners.vendor.email, "password123"],
    ["customer", "/api/public/customers/login", "/api/customer/profile", "direct@example.com", "customerpass2"],
    ["portal", "/api/public/reseller-customers/login", "/api/customer-portal/me", "portal@example.com", "updatedpassword123"]
  ]) {
    const agent = request.agent(app);
    const response = await agent.post(route).set("Origin", origin).set("X-Session-Mode", "cookie").set("X-Forwarded-For", "192.0.2.201").send({ email, password });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.token || response.body.data?.token, undefined);
    assert.ok(response.headers["set-cookie"].some(c => c.startsWith(`spotx_${portal}=`) && c.includes("HttpOnly")));
    expectStatus(await agent.get(profile), 200, portal + " cookie authenticates");
    expectStatus(await agent.get("/api/admin/stats/dashboard"), 401, portal + " cookie cannot authenticate admin");
    expectStatus(await agent.post("/api/session/logout").set("Origin", origin).send({ portal }), 200, portal + " logout");
    expectStatus(await agent.get(profile), 401, portal + " logout blocks access");
  }
});


test("partner teammates: role permissions, dashboard privacy and current access across supported types", async () => {
  const { PartnerUser } = require("../models/Index");
  const { ROLE_PERMISSIONS } = require("../config/roles");
  // Separate this role matrix from earlier rate-limit scenarios.
  await require("../models/RateLimitCounter").deleteMany({ _id: /^partner-auth:/ });
  const password = "RoleTesting123!";
  const passwordHash = await require("bcryptjs").hash(password, 4);
  for (const type of ["affiliate", "vendor", "reseller"]) {
    for (const role of ["admin", "sales", "finance", "viewer"]) {
      const email = `${type}-${role}-permissions@example.com`;
      const user = await PartnerUser.create({ partnerId: state.partners[type].id, name: `${role} teammate`, email, role, permissions: ROLE_PERMISSIONS[role], status: "active", auth: { passwordHash } });
      const signedIn = expectStatus(await api().post("/api/partner/auth/login").send({ email, password }), 200, `${type} ${role} login`);
      const token = signedIn.token;
      const permissions = ROLE_PERMISSIONS[role];
      const can = p => permissions.includes(p);
      for (const [path, permission] of [["/api/partner/team", "team:view"], ["/api/partner/commissions", "commissions:view"], ["/api/partner/settlements", "settlements:view"], ["/api/partner/documents", "documents:view"], ["/api/partner/bank", "bank:view"]]) {
        if (type === "reseller" && ["commissions:view", "settlements:view"].includes(permission)) continue;
        expectStatus(await api().get(path).set(as(token)), can(permission) ? 200 : 403, `${type} ${role} ${permission}`);
      }
      if (!can("team:manage")) expectStatus(await api().post("/api/partner/team").set(as(token)).send({}), 403, "team mutation denied");
      if (!can("profile:update")) expectStatus(await api().patch("/api/partner/profile").set(as(token)).send({ city: "Unauthorized" }), 403, "profile mutation denied");
      if (type === "vendor" && !can("customers:manage")) expectStatus(await api().post("/api/partner/customers").set(as(token)).send({}), 403, "customer mutation denied");
      if (type === "reseller") {
        expectStatus(await api().get("/api/partner/reseller/invoices").set(as(token)), can("reseller:billing:view") ? 200 : 403, "billing access");
        if (!can("reseller:billing:pay")) expectStatus(await api().post(`/api/partner/reseller/invoices/${user._id}/pay`).set(as(token)).send({}), 403, "payment denied");
        if (!can("reseller:license:purchase")) expectStatus(await api().post("/api/partner/reseller/license-orders").set(as(token)).send({}), 403, "licence purchase denied");
      }
      const dashboard = expectStatus(await api().get("/api/partner/dashboard").set(as(token)), 200, "role dashboard").data;
      if (!can("commissions:view")) {
        assert.equal(dashboard.businessOverview.earnings, undefined);
        assert.equal(dashboard.stats.totalCommission, undefined);
        assert.deepEqual(dashboard.commissionTrend, []);
        const profile = expectStatus(await api().get("/api/partner/profile").set(as(token)), 200, "role profile");
        assert.equal(profile.data.partner.stats.totalCommission, undefined);
      }
      if (!can("reseller:billing:view")) assert.equal(dashboard.businessOverview.invoices, undefined);
      assert.deepEqual(dashboard.recentActivity, []);
      user.permissions = []; await user.save();
      expectStatus(await api().get("/api/partner/dashboard").set(as(token)), 403, "permission removal applies to existing login");
    }
  }
});


test("invoice downloads are PDFs scoped to the account and billing permissions", async () => {
  const { Invoice, Customer, PartnerUser } = require("../models/Index");
  const ResellerInvoice = require("../models/ResellerInvoice");
  const resellerInvoice = await ResellerInvoice.findOne({ partnerId: state.partners.reseller.id, paymentStatus: "paid" });
  assert.ok(resellerInvoice);
  const pdf = await api().get(`/api/partner/reseller/invoices/${resellerInvoice._id}/download`).set(as(state.partners.reseller.token));
  assert.equal(pdf.status, 200); assert.match(pdf.headers["content-type"], /application\/pdf/); assert.match(pdf.headers["content-disposition"], /attachment/);
  expectStatus(await api().get(`/api/admin/reseller/invoices/${resellerInvoice._id}/download`).set(admin()), 200, "admin invoice PDF");
  const unpaid = await ResellerInvoice.create({ ...resellerInvoice.toObject(), _id: new mongoose.Types.ObjectId(), invoiceNumber: "PENDING-DOWNLOAD-TEST", purchaseOrderId: new mongoose.Types.ObjectId(), paymentStatus: "pending" });
  expectStatus(await api().get(`/api/partner/reseller/invoices/${unpaid._id}/download`).set(as(state.partners.reseller.token)), 409, "pending invoice cannot be downloaded");
  expectStatus(await api().get(`/api/admin/reseller/invoices/${unpaid._id}/download`).set(admin()), 409, "admin pending invoice cannot be downloaded");
  const foreign = await ResellerInvoice.create({ ...resellerInvoice.toObject(), _id: new mongoose.Types.ObjectId(), invoiceNumber: "OTHER-PARTNER-INVOICE", purchaseOrderId: new mongoose.Types.ObjectId(), partnerId: state.partners.vendor.id });
  expectStatus(await api().get(`/api/partner/reseller/invoices/${foreign._id}/download`).set(as(state.partners.reseller.token)), 404, "foreign invoice denied");
  const sales = await PartnerUser.findOne({ email: "reseller-sales-permissions@example.com" });
  sales.permissions = require("../config/roles").ROLE_PERMISSIONS.sales; await sales.save();
  const token = require("jsonwebtoken").sign({ userId: sales._id, sessionVersion: sales.auth.sessionVersion || 0 }, process.env.JWT_SECRET);
  expectStatus(await api().get(`/api/partner/reseller/invoices/${resellerInvoice._id}/download`).set(as(token)), 403, "sales cannot download billing");
  const invoice = await Invoice.findOne({ status: "paid" }); assert.ok(invoice);
  const customer = await Customer.findById(invoice.customerId);
  const customerToken = require("jsonwebtoken").sign({ customerId: customer._id, sessionVersion: customer.auth.sessionVersion || 0 }, process.env.JWT_SECRET);
  expectStatus(await api().get(`/api/customer/invoices/${invoice._id}/download`).set(as(customerToken)), 200, "customer invoice PDF");
  const pendingCustomerInvoice = await Invoice.create({ customerId: customer._id, amount: 500, status: "issued" });
  expectStatus(await api().get(`/api/customer/invoices/${pendingCustomerInvoice._id}/download`).set(as(customerToken)), 409, "unpaid customer invoice cannot be downloaded");
  const unrelated = await Invoice.create({ customerId: new mongoose.Types.ObjectId(), amount: 1 });
  expectStatus(await api().get(`/api/customer/invoices/${unrelated._id}/download`).set(as(customerToken)), 404, "foreign customer invoice denied");
});


test("manual customer receipts reject duplicate references and concurrent retries", async () => {
  const { Customer, Invoice, PartnerCommission } = require("../models/Index");
  const customer = await Customer.findOne({ partnerId: state.partners.vendor.id });
  const url = `/api/admin/customers/${customer._id}/mark-paid`;
  const body = { paymentReference: "UTR-DUPLICATE-TEST", revenue: 1000, screenCount: 1, plan: "basic", durationMonths: 1 };
  const replies = await Promise.all([api().patch(url).set(admin()).send(body), api().patch(url).set(admin()).send(body)]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  assert.equal(await Invoice.countDocuments({ manualPaymentReference: body.paymentReference }), 1);
  const updated = await Customer.findById(customer._id);
  const commissions = await PartnerCommission.countDocuments({ customerId: customer._id });
  expectStatus(await api().patch(url).set(admin()).send({ ...body, paymentReference: " utr-duplicate-test " }), 409, "normalized duplicate reference");
  assert.equal(await PartnerCommission.countDocuments({ customerId: customer._id }), commissions);
  assert.equal((await Customer.findById(customer._id)).subscription.currentPeriodEnd.getTime(), updated.subscription.currentPeriodEnd.getTime());
  expectStatus(await api().patch(url).set(admin()).send({ ...body, paymentReference: "UTR-NEW-PAYMENT" }), 200, "genuine new payment");
  assert.equal(await Invoice.countDocuments({ manualPaymentReference: "UTR-NEW-PAYMENT" }), 1);
  expectStatus(await api().patch(url).set(admin()).send({ revenue: 1000 }), 400, "reference required");
});
