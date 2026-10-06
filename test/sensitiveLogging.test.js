const assert = require("node:assert/strict");
const test = require("node:test");
const safeRequestPath = require("../utils/safeRequestPath");

test("request paths redact reset tokens and remove query strings", () => {
  assert.equal(safeRequestPath("/api/partner/auth/reset-password/private-token?secret=value"), "/api/partner/auth/reset-password/[redacted]");
  assert.equal(safeRequestPath("/api/public/customers/reset-password/private-token"), "/api/public/customers/reset-password/[redacted]");
  assert.equal(safeRequestPath("/api/admin/partners?page=1"), "/api/admin/partners");
});

test("missing SMTP configuration never prints email content or credentials", async () => {
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await require("../utils/mailer").sendMail({
      to: "private@example.com", subject: "Secret invitation", text: "Password: secret-password https://example.com/reset-password/private-token"
    });
    assert.equal(result.delivered, false);
  } finally {
    console.log = original;
  }
  assert.ok(!lines.join(" ").includes("secret-password"));
  assert.ok(!lines.join(" ").includes("private-token"));
  assert.ok(!lines.join(" ").includes("private@example.com"));
});
