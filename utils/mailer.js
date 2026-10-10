const nodemailer = require("nodemailer");

// Gmail requires a 16-character App Password (not the account password) —
// generated under Google Account → Security → 2-Step Verification → App
// Passwords. Regular Gmail passwords are rejected by SMTP auth.
let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;

  transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    requireTLS: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  return transporter;
};

const sendMail = async ({ to, subject, html, text }) => {
  const t = getTransporter();

  // No SMTP creds configured — fall back to logging so local dev still
  // works without a Gmail account on hand.
  if (!t) {
    console.log("[DEV] Email delivery skipped: SMTP is not configured.");
    return { delivered: false };
  }

  await t.sendMail({
    from: `"SPOTX Partners" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html,
    text
  });

  return { delivered: true };
};

module.exports = { sendMail };
