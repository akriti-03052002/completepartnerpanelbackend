const crypto = require("crypto");
const { sendMail } = require("../utils/mailer");
const sendResellerCustomerLink = async (customer) => {
  const token = crypto.randomBytes(32).toString("hex");
  customer.auth.verifyTokenHash = crypto.createHash("sha256").update(token).digest("hex");
  customer.auth.verifyTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await customer.save();
  const link = `${(process.env.CLIENT_URL || "http://localhost:5173").replace(/\/+$/, "")}/reseller/customer/verify/${token}`;
  const result = await sendMail({ to: customer.contactDetails.email, subject: "Verify your SPOTX email or reset your password", text: `Verify your email and set your password: ${link}\nThis link expires in 24 hours. If you did not request this, ignore it.` });
  return result?.delivered === true;
};
module.exports = { sendResellerCustomerLink };
