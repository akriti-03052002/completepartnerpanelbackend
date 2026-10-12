const NAME = /^[\p{L}\p{M}]+(?:[ '\u2019-][\p{L}\p{M}]+)*$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hasControl = value => [...value].some(character => character.charCodeAt(0) < 32);
const phoneValid = value => typeof value === "string" && /^\+?[\d ()-]+$/.test(value.trim()) && /^[1-9]\d{6,14}$/.test(value.replace(/\D/g, ""));

function validateRegistration(values, { partner = false, google = false, reseller = false } = {}) {
  const issues = {};
  const nameField = reseller ? "name" : "contactName";
  const name = values[nameField];
  if (partner || name !== undefined && name !== "") {
    if (typeof name !== "string" || name.trim().length > 100 || !NAME.test(name.trim())) issues[nameField] = "Name must contain letters only, with spaces, apostrophes or hyphens. Numbers are not allowed.";
  }
  if (!google && (typeof values.email !== "string" || values.email.length > 254 || !EMAIL.test(values.email.trim()))) issues.email = "Enter a valid email address.";
  if (partner || values.phone !== undefined && values.phone !== "") {
    if (!phoneValid(values.phone)) issues.phone = "Enter a valid phone number with 7 to 15 digits, including the country code.";
  }
  if (partner && !["vendor", "reseller", "affiliate", "influencer"].includes(values.partnerType)) issues.partnerType = "Choose a valid partner role.";
  if (!partner) {
    if (typeof values.companyName !== "string" || !values.companyName.trim() || values.companyName.trim().length > 150 || hasControl(values.companyName)) issues.companyName = "Enter a company name of up to 150 characters.";
    if (typeof values.referralCode !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(values.referralCode.trim())) issues.referralCode = "Enter a valid referral code using letters, numbers, hyphens or underscores.";
  }
  for (const field of ["country", "state", "city", "addressLine1", "addressLine2"]) {
    if (values[field] !== undefined && (typeof values[field] !== "string" || values[field].length > 200 || hasControl(values[field]))) issues[field] = "Enter valid address details of up to 200 characters.";
  }
  if (values.pincode !== undefined && values.pincode !== "") {
    const postal = values.pincode;
    const pattern = values.country === "India" ? /^[1-9]\d{5}$/ : /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/;
    if (typeof postal !== "string" || !pattern.test(postal.trim())) issues.pincode = values.country === "India" ? "Enter a valid 6-digit PIN code." : "Enter a valid postal code.";
  }
  if (!google && !reseller && (typeof values.password !== "string" || values.password.length < 8 || values.password.length > 128)) issues.password = "Password must be between 8 and 128 characters.";
  return issues;
}

const registrationFields = options => (req, res, next) => {
  const errors = validateRegistration(req.body || {}, { ...options, google: Boolean(req.googleIdentity) });
  if (Object.keys(errors).length) return res.status(400).json({ success: false, message: Object.values(errors)[0], errors });
  for (const field of ["contactName", "name", "companyName", "email", "phone", "referralCode", "country", "state", "city", "addressLine1", "addressLine2", "pincode"]) {
    if (typeof req.body[field] === "string") req.body[field] = req.body[field].trim();
  }
  return next();
};
module.exports = { validateRegistration, registrationFields };
