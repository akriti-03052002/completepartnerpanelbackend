const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const Store = require("../utils/MongoRateLimitStore");
const Counter = require("../models/RateLimitCounter");
const pagination = require("../utils/pagination");
const runWithLease = require("../utils/runWithLease");
let mongo;
before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Counter.init();
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
test("pagination bounds invalid and excessive inputs", () => {
  assert.deepEqual(pagination({ page: "-1", limit: "no" }), { page: 1, limit: 50, skip: 0 });
  assert.deepEqual(pagination({ page: "2", limit: "5000" }), { page: 2, limit: 100, skip: 100 });
});
test("independent API instances share atomic counters and isolate limiter namespaces", async () => {
  const a = new Store("shared"), b = new Store("shared"), other = new Store("other");
  for (const store of [a, b, other]) store.init({ windowMs: 60000 });
  const hits = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).increment("client")));
  assert.deepEqual(hits.map((hit) => hit.totalHits).sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i + 1));
  assert.equal((await other.increment("client")).totalHits, 1);
  await Counter.updateOne({ _id: "shared:client" }, { $set: { resetTime: new Date(0) } });
  assert.equal((await b.increment("client")).totalHits, 1);
  await b.decrement("client");
  assert.equal((await a.increment("client")).totalHits, 1);
  await a.resetKey("client");
  assert.equal((await b.increment("client")).totalHits, 1);
});
test("database lease prevents simultaneous jobs and releases after failures", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const first = runWithLease("scalability-job", async () => { entered(); await blocked; return "done"; });
  await started;
  assert.deepEqual(await runWithLease("scalability-job", () => assert.fail("duplicate execution")), { skipped: true });
  release();
  assert.equal(await first, "done");
  await assert.rejects(runWithLease("scalability-job", async () => { throw new Error("failure"); }));
  assert.equal(await runWithLease("scalability-job", async () => "retry"), "retry");
});

test("lead pagination preserves whole-dataset overview totals", async () => {
  const Partner = require("../models/Partner");
  const Referral = require("../models/Partnerreferral");
  const partnerId = new mongoose.Types.ObjectId();
  await Partner.collection.insertOne({ _id: partnerId, partnerCode: "scale-affiliate", partnerType: "affiliate" });
  await Referral.collection.insertMany(Array.from({ length: 120 }, (_, i) => ({
    partnerId, status: i < 60 ? "won" : "new", updatedAt: new Date(i), closure: { dealValue: 10 }
  })));
  let body;
  await require("../controller/adminLeadController").listLeads(
    { query: { partnerId: String(partnerId), page: "2" } }, { json: (value) => { body = value; } }
  );
  assert.equal(body.data.length, 50);
  assert.equal(body.pagination.total, 120);
  assert.equal(body.summary.won.count, 60);
  assert.equal(body.summary.won.value, 600);
});
test("submission pagination returns all-status counts without exposing social credentials", async () => {
  const Partner = require("../models/Partner");
  const Submission = require("../models/InfluencerContentSubmission");
  const partnerId = new mongoose.Types.ObjectId(), accountId = new mongoose.Types.ObjectId();
  await Partner.collection.insertOne({ _id: partnerId, partnerCode: "scale-influencer", partnerType: "influencer", primaryContact: { name: "Test" },
    socialAccounts: [{ _id: accountId, platform: "youtube", username: "test", accessTokenEncrypted: "secret" }] });
  await Submission.collection.insertMany(Array.from({ length: 120 }, (_, i) => ({
    partnerId, socialAccountId: accountId, status: i < 80 ? "pending" : "approved", createdAt: new Date(i)
  })));
  let body;
  await require("../controller/adminSocialMediaController").listSubmissions(
    { query: { partnerId: String(partnerId), status: "pending", page: "2" } }, { json: (value) => { body = value; } }
  );
  assert.equal(body.data.length, 30);
  assert.equal(body.pagination.total, 80);
  assert.equal(body.counts.approved, 40);
  assert.equal(body.data[0].socialAccount.username, "test");
  assert.ok(!JSON.stringify(body).includes("secret"));
  assert.equal(body.data[0].partnerId.socialAccounts, undefined);
});

test("vendor commissions require an individual assignment and ignore tier and generic rates", async () => {
  const Rule = require("../models/Commissionrule");
  const Assignment = require("../models/PartnerCommissionAssignment");
  const { findApplicableCommissionRule } = require("../utils/partnerCommissionResolver");
  const tierId = new mongoose.Types.ObjectId();
  const partner = { _id: new mongoose.Types.ObjectId(), partnerType: "vendor", program: { tierId } };
  const generic = await Rule.create({ name: "Vendor fallback", partnerType: "vendor", status: "active", commissionType: "percentage", rate: 10 });
  const tier = await Rule.create({ name: "Existing tier", tierId, partnerType: "vendor", status: "active", commissionType: "percentage", rate: 15 });
  assert.equal(await findApplicableCommissionRule(partner), null);
  const customId = new mongoose.Types.ObjectId();
  await Assignment.collection.insertOne({ _id: customId, partnerId: partner._id, status: "active", commissionType: "percentage", rate: 25, assignedAt: new Date() });
  const selected = await findApplicableCommissionRule(partner);
  assert.equal(String(selected._id), String(customId));
  assert.equal(selected.rate, 25);
  await Assignment.deleteOne({ _id: customId });
  await Rule.deleteMany({ _id: { $in: [generic._id, tier._id] } });
});

test("vendor scenarios: missing and inactive assignments, all payout types, repeat payments, changed rates and expired terms", async (t) => {
  const Partner = require("../models/Partner");
  const Bank = require("../models/Partnerbankaccount");
  const Assignment = require("../models/PartnerCommissionAssignment");
  const Commission = require("../models/Partnercommission");
  const { generateCommissionForCustomerPayment: pay } = require("../services/commissionEngine");
  const partner = { _id: new mongoose.Types.ObjectId(), partnerType: "vendor", program: {},
    stats: { totalRevenue: 0, totalCommission: 0, pendingCommission: 0 }, save: async () => {} };
  t.mock.method(Partner, "findById", async () => partner);
  t.mock.method(Bank, "findOne", async () => ({ commissionEligibility: "eligible" }));
  const customer = () => ({ _id: new mongoose.Types.ObjectId(), partnerId: partner._id, companyName: "Scenario customer" });
  const args = (c) => ({ customer: c, revenue: 10000, screenCount: 20 });
  await assert.rejects(pay(args(customer())), /No active commission assignment/);
  const inactive = await Assignment.create({ assignedBy: new mongoose.Types.ObjectId(), partnerId: partner._id, commissionType: "percentage", rate: 99, status: "superseded" });
  await assert.rejects(pay(args(customer())), /No active commission assignment/);
  assert.equal(await Commission.countDocuments({ partnerId: partner._id }), 0);
  await Assignment.deleteOne({ _id: inactive._id });
  for (const [terms, expected] of [
    [{ commissionType: "percentage", rate: 15 }, 1500],
    [{ commissionType: "fixed_per_deal", fixedAmount: 300 }, 300],
    [{ commissionType: "fixed_per_screen", perScreenAmount: 25 }, 500],
    [{ commissionType: "hybrid", hybrid: { percentageRate: 10, fixedAmount: 200, perScreenAmount: 5 } }, 1300]
  ]) {
    const assignment = await Assignment.create({ assignedBy: new mongoose.Types.ObjectId(), partnerId: partner._id, status: "active", ...terms });
    const c = customer();
    const first = await pay(args(c));
    assert.equal(first.commission.calculation.netCommission, expected);
    assert.equal(first.commission.commissionRuleId, undefined);
    assert.equal((await pay(args(c))).skipped, "one_time_already_earned");
    await Assignment.deleteOne({ _id: assignment._id });
  }
  const recurring = await Assignment.create({ assignedBy: new mongoose.Types.ObjectId(), partnerId: partner._id, status: "active", commissionType: "recurring_percentage", rate: 10,
    recurring: { enabled: true, durationType: "lifetime" } });
  const c = customer();
  const first = await pay(args(c));
  assert.equal(first.commission.calculation.netCommission, 1000);
  await Assignment.updateOne({ _id: recurring._id }, { $set: { rate: 20 } });
  const second = await pay(args(c));
  assert.equal(second.commission.calculation.netCommission, 2000);
  assert.equal(second.commission.recurring.cycleNumber, 2);
  assert.equal((await Commission.findById(first.commission._id)).calculation.netCommission, 1000);
  await Assignment.updateOne({ _id: recurring._id }, { $set: { "recurring.durationType": "months", "recurring.duration": 1 } });
  await Commission.collection.updateOne({ _id: first.commission._id }, { $set: { createdAt: new Date(Date.now() - 90 * 86400000) } });
  assert.equal((await pay(args(c))).skipped, "recurring_period_ended");
  await Assignment.deleteOne({ _id: recurring._id });
});

test("captured payments recover missing commissions once without changing newer subscriptions", async (t) => {
  const { Partner, Customer, PartnerBankAccount, PartnerCommission, Invoice } = require("../models/Index");
  const Assignment = require("../models/PartnerCommissionAssignment");
  const Payment = require("../models/CustomerPayment");
  const { applyPaidCustomerPayment: apply, recoverPendingCustomerCommissions: recover } = require("../services/customerPaymentFulfillment");
  const partner = await Partner.create({ partnerCode: "RECOVERY-VENDOR", partnerType: "vendor", primaryContact: { name: "Recovery", email: "recovery@test.example" } });
  await PartnerBankAccount.collection.insertOne({ partnerId: partner._id, commissionEligibility: "eligible" });
  const customer = await Customer.create({ companyName: "Recovery", email: "customer-recovery@test.example", partnerId: partner._id });
  const payment = await Payment.create({ customerId: customer._id, partnerId: partner._id, plan: "basic", screenCount: 10,
    durationMonths: 1, changeType: "immediate", amount: { base: 10000, gstRatePercent: 18, gst: 1800, total: 11800 },
    period: { start: new Date(), end: new Date(Date.now() + 30 * 86400000) }, razorpay: { orderId: "order_recovery" } });
  await assert.rejects(apply(payment._id, { razorpayPaymentId: "pay_recovery" }), /No active commission assignment/);
  const pending = await Payment.findById(payment._id);
  assert.equal(pending.status, "paid");
  assert.equal(pending.commissionGenerated, false);
  assert.equal((await Customer.findById(customer._id)).subscription.status, "active");
  assert.equal(await Invoice.countDocuments({ customerPaymentId: payment._id }), 1);
  assert.equal(await PartnerCommission.countDocuments({ customerId: customer._id }), 0);
  // Simulate a later subscription change: recovery must not undo it.
  await Customer.updateOne({ _id: customer._id }, { $set: { "subscription.screenCount": 50 } });
  await Assignment.create({ partnerId: partner._id, assignedBy: new mongoose.Types.ObjectId(), status: "active", commissionType: "recurring_percentage", rate: 15, recurring: { enabled: true, durationType: "lifetime" } });
  // Fail after the ledger and totals are written: the whole commission
  // transaction must roll back so the next retry can safely generate it.
  const Notification = require("../models/Index").PartnerNotification;
  const failNotification = t.mock.method(Notification, "create", async () => { throw new Error("notification unavailable"); });
  await assert.rejects(apply(payment._id, { razorpayPaymentId: "pay_recovery" }), /notification unavailable/);
  failNotification.mock.restore();
  assert.equal(await PartnerCommission.countDocuments({ customerId: customer._id }), 0);
  assert.equal((await Partner.findById(partner._id)).stats.totalCommission, 0);
  assert.equal((await Payment.findById(payment._id)).commissionGenerated, false);
  await Promise.all([apply(payment._id, { razorpayPaymentId: "pay_recovery" }), apply(payment._id, { razorpayPaymentId: "pay_recovery" })]);
  await recover();
  assert.equal(await PartnerCommission.countDocuments({ customerId: customer._id }), 1);
  assert.equal(await Invoice.countDocuments({ customerPaymentId: payment._id }), 1);
  assert.equal((await Payment.findById(payment._id)).commissionGenerated, true);
  assert.equal((await Customer.findById(customer._id)).subscription.screenCount, 50);
  const earned = await PartnerCommission.findOne({ customerId: customer._id });
  assert.equal(earned.calculation.netCommission, 1500);
  assert.equal(earned.transaction.screenCount, 10);
  const totals = (await Partner.findById(partner._id)).stats;
  assert.equal(totals.totalCommission, 1500);
  assert.equal(totals.totalRevenue, 10000);
  assert.equal(totals.referredScreens, 50);
});
