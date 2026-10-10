const assert = require("node:assert/strict");
const { test } = require("node:test");
const { sendMail } = require("../utils/mailer");

test("Resend delivers through HTTPS and rejects failed requests without SMTP fallback", async () => {
  const originalFetch = global.fetch;
  const originalEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, EMAIL_FROM: process.env.EMAIL_FROM, EMAIL_FROM_NAME: process.env.EMAIL_FROM_NAME };
  process.env.RESEND_API_KEY = "test-key";
  process.env.EMAIL_FROM = "onboarding@resend.dev";
  process.env.EMAIL_FROM_NAME = "SPOTX";
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(options.headers.Authorization, "Bearer test-key");
      const payload = JSON.parse(options.body);
      assert.equal(payload.from, "SPOTX <onboarding@resend.dev>");
      assert.deepEqual(payload.to, ["test@example.com"]);
      assert.equal(payload.text, "Code 123456");
      return { ok: true, json: async () => ({ id: "email-id" }) };
    };
    assert.deepEqual(await sendMail({ to: "test@example.com", subject: "OTP", text: "Code 123456" }), { delivered: true });
    for (const status of [401, 403, 429, 500]) {
      global.fetch = async () => ({ ok: false, status, json: async () => ({ message: "sensitive-provider-payload" }) });
      await assert.rejects(sendMail({ to: "test@example.com" }), error => !error.message.includes("sensitive-provider-payload") && /Resend|Email service/.test(error.message));
    }
    global.fetch = async () => { throw new Error("network failure"); };
    await assert.rejects(sendMail({ to: "test@example.com" }), /could not be reached/);
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
