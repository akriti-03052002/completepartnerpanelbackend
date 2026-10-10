const { OAuth2Client } = require("google-auth-library");

const client = new OAuth2Client();

const googleConfig = (_req, res) => res.json({
  success: true,
  clientId: process.env.GOOGLE_CLIENT_ID || ""
});

const verifyGoogleIdentity = async (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({ success: false, message: "Google sign-in is not configured yet." });
  }
  if (typeof req.body?.credential !== "string" || req.body.credential.length > 10000) {
    return res.status(400).json({ success: false, message: "A Google sign-in credential is required." });
  }
  try {
    const ticket = await client.verifyIdToken({ idToken: req.body.credential, audience: process.env.GOOGLE_CLIENT_ID });
    const identity = ticket.getPayload();
    if (!identity?.sub || !identity.email || identity.email_verified !== true ||
        typeof req.body.nonce !== "string" || !req.body.nonce || identity.nonce !== req.body.nonce) throw new Error("Unverified identity");
    req.googleIdentity = identity;
    // Never trust the email or name supplied by the browser as proof of identity.
    req.body.email = identity.email.toLowerCase().trim();
    req.body.contactName = req.body.contactName || identity.name || "";
    req.body.name = req.body.name || identity.name || "";
    return next();
  } catch {
    return res.status(401).json({ success: false, message: "Google sign-in could not be verified. Please try again." });
  }
};

// Only Google-managed addresses are safe to link automatically by email.
// Other addresses need an account ownership check before they can be linked.
const bindGoogleAccount = async (account, identity) => {
  if (account.auth.googleSub && account.auth.googleSub !== identity.sub) return false;
  if (!account.auth.googleSub && !identity.email.toLowerCase().endsWith("@gmail.com") && !identity.hd) return false;
  account.auth.googleSub = identity.sub;
  account.auth.emailVerified = true;
  return true;
};

const googleLogin = (Model, emailField, loginHandler) => async (req, res, next) => {
  try {
    const matches = await Model.find({ $or: [
      { "auth.googleSub": req.googleIdentity.sub },
      { [emailField]: req.body.email }
    ] }).limit(2).select("+auth.passwordHash +auth.googleSub");
    if (!matches.length) return res.status(404).json({ success: false, message: "No account found. Register first using your Google account." });
    if (matches.length !== 1 || !await bindGoogleAccount(matches[0], req.googleIdentity)) {
      return res.status(409).json({ success: false, message: "This account cannot be linked automatically. Sign in with your password or contact support." });
    }
    req.googleAccount = matches[0];
    return loginHandler(req, res, next);
  } catch (error) { return next(error); }
};

module.exports = { googleConfig, verifyGoogleIdentity, bindGoogleAccount, googleLogin };
