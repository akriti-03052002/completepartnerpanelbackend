const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const crypto = require("node:crypto");
const express = require("express");
const request = require("supertest");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { OAuth2Client } = require("google-auth-library");

process.env.NODE_ENV = "test";
process.env.CLIENT_URL = "http://localhost:5173";
process.env.GOOGLE_CLIENT_ID = "redirect-test.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "test-client-secret";
process.env.JWT_SECRET = "test-encryption-secret";
const Attempt = require("../models/GoogleSignInAttempt");
const app = express();
app.use(express.json());
app.use("/api/auth/google", require("../router/googleRedirectRoutes"));
let mongo;
let exchanges = 0;
let identity;
const originalGetToken = OAuth2Client.prototype.getToken;
const originalVerify = OAuth2Client.prototype.verifyIdToken;
OAuth2Client.prototype.getToken = async ({ code, codeVerifier, redirect_uri }) => {
  exchanges++;
  assert.equal(code, "test-code");
  assert.equal(redirect_uri, "http://localhost:5173/api/auth/google/callback");
  assert.ok(codeVerifier);
  return { tokens: { id_token: "verified-google-token" } };
};
OAuth2Client.prototype.verifyIdToken = async () => ({ getPayload: () => identity });
before(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Attempt.init();
});
after(async () => {
  OAuth2Client.prototype.getToken = originalGetToken;
  OAuth2Client.prototype.verifyIdToken = originalVerify;
  await mongoose.disconnect();
  await mongo.stop();
});
const origin = "http://localhost:5173";
async function start(endpoint = "/partner/auth", mode = "login") {
  const res = await request(app).post("/api/auth/google/start").set("Origin", origin)
    .send({ endpoint, mode, returnTo: `${origin}/partner/login?ref=keep` });
  assert.equal(res.status, 200);
  const url = new URL(res.body.url);
  const cookie = res.headers["set-cookie"][0].split(";")[0];
  identity = { sub: "google-sub", email: "test@gmail.com", email_verified: true, nonce: url.searchParams.get("nonce") };
  const attempt = await Attempt.findOne({ stateHash: crypto.createHash("sha256").update(url.searchParams.get("state")).digest("hex") });
  assert.equal(url.searchParams.get("code_challenge"), crypto.createHash("sha256").update(attempt.verifier).digest("base64url"));
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.match(res.headers["set-cookie"][0], /HttpOnly/);
  return { cookie, state: url.searchParams.get("state"), nonce: identity.nonce, attempt };
}
const callback = flow => request(app).get("/api/auth/google/callback").set("Cookie", flow.cookie).query({ code: "test-code", state: flow.state });
const result = flow => request(app).post("/api/auth/google/result").set("Origin", origin).set("Cookie", flow.cookie);

test("redirect preserves portal context, encrypts credentials, consumes result once for every account type", async () => {
  for (const endpoint of ["/partner/auth", "/public/customers", "/public/reseller-customers"]) {
    for (const mode of ["login", "register"]) {
      const flow = await start(endpoint, mode);
      const returned = await callback(flow);
      assert.equal(returned.status, 303);
      assert.equal(returned.headers.location, `${origin}/partner/login?ref=keep&google_return=1`);
      assert.ok(!(returned.headers.location.includes("token")));
      const stored = await Attempt.findById(flow.attempt.id);
      assert.notEqual(stored.credential, "verified-google-token");
      assert.equal(stored.verifier, undefined);
      const completed = await result(flow);
      assert.equal(completed.status, 200);
      assert.equal(completed.body.credential, "verified-google-token");
      assert.equal(completed.body.nonce, flow.nonce);
      assert.equal(completed.body.endpoint, endpoint);
      assert.equal(completed.body.mode, mode);
      assert.equal((await result(flow)).status, 400);
      assert.equal((await callback(flow)).status, 400);
    }
  }
});
test("rejects foreign origins, redirect destinations and unsupported portals", async () => {
  for (const [from, body, status] of [
    ["https://attacker.example", { endpoint: "/partner/auth", mode: "login", returnTo: `${origin}/partner/login` }, 403],
    [origin, { endpoint: "/partner/auth", mode: "login", returnTo: "https://attacker.example" }, 400],
    [origin, { endpoint: "/admin/auth", mode: "login", returnTo: `${origin}/partner/login` }, 400]
  ]) {
    assert.equal((await request(app).post("/api/auth/google/start").set("Origin", from).send(body)).status, status);
  }
});
test("wrong state, wrong browser and expired state never exchange a Google code", async () => {
  const flow = await start();
  const previous = exchanges;
  assert.equal((await callback({ ...flow, state: "wrong" })).status, 400);
  assert.equal((await callback({ ...flow, cookie: "spotx_google_redirect=wrong" })).status, 400);
  await Attempt.updateOne({ _id: flow.attempt.id }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await callback(flow)).status, 400);
  assert.equal(exchanges, previous);
});
test("cancelled sign-in and nonce mismatch return safe errors without credentials", async () => {
  let flow = await start();
  const cancelled = await request(app).get("/api/auth/google/callback").set("Cookie", flow.cookie).query({ state: flow.state, error: "access_denied" });
  assert.equal(cancelled.status, 303);
  let response = await result(flow);
  assert.equal(response.status, 401);
  assert.match(response.body.message, /cancelled/);
  assert.equal(response.body.credential, undefined);
  flow = await start();
  identity.nonce = "wrong";
  assert.equal((await callback(flow)).status, 303);
  response = await result(flow);
  assert.equal(response.status, 401);
  assert.equal(response.body.credential, undefined);
});
