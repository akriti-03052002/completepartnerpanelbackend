const crypto = require("crypto");
const { sendMail } = require("../utils/mailer");

const RESET_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — same window as the partner activation link

/**
 * Generates a set/reset-password token for a customer, stores it, and
 * emails them the link. Used both when a partner registers a customer
 * directly (no password field on that form — the customer sets their own)
 * and for a standalone password reset. Neither the partner nor an admin
 * ever sets or sees the customer's actual password.
 */
const sendCustomerSetPasswordEmail = async (customer, { isNewAccount = false } = {}) => {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  customer.auth.resetTokenHash = tokenHash;
  customer.auth.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await customer.save();

  const link = `${process.env.CLIENT_URL || "http://localhost:5173"}/customer/reset-password/${rawToken}`;
  const subject = isNewAccount ? "Set your SPOTX Customer password" : "Reset your SPOTX Customer password";

  await sendMail({
    to: customer.email,
    subject,
    text: `${isNewAccount ? "Your SPOTX Customer account is ready. Set your password to log in" : "Reset your SPOTX Customer password"}: ${link}\n\nThis link expires in 7 days.`,
    html: `
      <p>${isNewAccount ? "Your SPOTX Customer account is ready." : "We received a request to reset your SPOTX Customer account password."}</p>
      <p><a href="${link}">${isNewAccount ? "Set your password to log in" : "Reset your password"}</a></p>
      <p>This link expires in 7 days.${isNewAccount ? "" : " If you didn't request this, ignore this email."}</p>
    `
  });
};

module.exports = { sendCustomerSetPasswordEmail };
