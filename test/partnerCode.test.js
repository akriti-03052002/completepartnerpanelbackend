const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Sequence = require("../models/CodeSequence");
const Partner = require("../models/Partner");
const { generatePartnerCode } = require("../utils/generateCode");
let mongo;
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([Sequence.init(), Partner.init()]);
});
after(async () => { await mongoose.disconnect(); await mongo.stop(); });
test("four-digit codes skip existing codes and concurrent requests remain unique", async () => {
  await Partner.create({ partnerCode: "1000", partnerType: "vendor", primaryContact: { name: "Test Vendor", email: "vendor@example.com" } });
  await Partner.create({ partnerCode: "PTN-OLD", partnerType: "affiliate", primaryContact: { name: "Test Affiliate", email: "affiliate@example.com" } });
  const codes = await Promise.all(Array.from({ length: 20 }, () => generatePartnerCode()));
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) { assert.match(code, /^[1-9]\d{3}$/); assert.notEqual(code, "1000"); }
  assert.ok(await Partner.exists({ partnerCode: "PTN-OLD" }));
});
test("the last code is 9999 and exhaustion never produces a fifth digit", async () => {
  await Sequence.updateOne({ _id: "partner" }, { $set: { value: 9998 } }, { upsert: true });
  assert.equal(await generatePartnerCode(), "9999");
  await assert.rejects(generatePartnerCode(), error => error.statusCode === 503);
});
