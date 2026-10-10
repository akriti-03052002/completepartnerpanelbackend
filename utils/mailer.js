const nodemailer = require("nodemailer");

// Gmail requires a 16-character App Password (not the account password) —
// generated under Google Account → Security → 2-Step Verification → App
// Passwords. Regular Gmail passwords are rejected by SMTP auth.
let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;

  transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  return transporter;
};

const sendMail = async ({ to, subject, html, text }) => {
  if (process.env.RESEND_API_KEY) {
    let response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: `${process.env.EMAIL_FROM_NAME || "SPOTX Partners"} <${process.env.EMAIL_FROM || "onboarding@resend.dev"}>`,
          to: Array.isArray(to) ? to : [to],
          subject, html, text
        }),
        signal: AbortSignal.timeout(15000)
      });
    } catch {
      throw new Error("Email service could not be reached. Please try again later.");
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.id) {
      // Do not log provider payloads: they may contain recipients or credentials.
      const message = response.status === 403
        ? "Resend rejected email delivery. Verify your sender domain; the test sender can only email your Resend account address."
        : response.status === 401
          ? "Resend authentication failed. Check RESEND_API_KEY."
          : response.status === 429
            ? "Email service limit reached. Please try again later."
            : "Email service rejected delivery. Check the Resend dashboard.";
      throw new Error(message);
    }
    return { delivered: true };
  }

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
