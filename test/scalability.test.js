const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Store = require("../utils/MongoRateLimitStore");
const Counter = require("../models/RateLimitCounter");
const pagination = require("../utils/pagination");
const runWithLease = require("../utils/runWithLease");
let mongo;
before(async () => {
  mongo = await MongoMemoryServer.create();
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
