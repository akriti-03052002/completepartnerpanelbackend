const express = require("express");
const crypto = require("node:crypto");
const { OAuth2Client } = require("google-auth-library");
const rateLimit = require("express-rate-limit");
const MongoRateLimitStore = require("../utils/MongoRateLimitStore");
const Attempt = require("../models/GoogleSignInAttempt");
const isApplicationOrigin = require("../utils/applicationOrigin");

const router = express.Router();
const cookieName = "spotx_google_redirect";
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/auth/google" });
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const random = () => crypto.randomBytes(32).toString("base64url");
const browserId = req => {
  const item = (req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`));
  return item ? item.slice(cookieName.length + 1) : "";
};
const encryptionKey = () => crypto.createHash("sha256").update(process.env.JWT_SECRET).digest();
const encrypt = value => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
};
const decrypt = value => {
  const data = Buffer.from(value, "base64url");
  const cipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), data.subarray(0, 12));
  cipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8");
};
const client = redirectUri => new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
const requireOrigin = (req, res, next) => {
  if (!isApplicationOrigin(req.get("origin"))) return res.status(403).json({ success: false, message: "Google sign-in must start from the application." });
  return next();
};
const limiter = rateLimit({
  store: new MongoRateLimitStore("google-redirect"), windowMs: 15 * 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { success: false, message: "Too many sign-in attempts. Please try again later." }
});
router.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  next();
});

router.post("/start", requireOrigin, limiter, async (req, res, next) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.JWT_SECRET) {
      return res.status(503).json({ success: false, message: "Google sign-in is not configured yet." });
    }
    const { endpoint, mode, returnTo } = req.body;
    if (!["/partner/auth", "/public/customers", "/public/reseller-customers"].includes(endpoint) || !["login", "register"].includes(mode)) {
      return res.status(400).json({ success: false, message: "Invalid Google sign-in account type." });
    }
    let returnUrl;
    try { returnUrl = new URL(returnTo); } catch { /* invalid URL handled below */ }
    if (!returnUrl || returnUrl.origin !== req.get("origin") || returnUrl.username || returnUrl.password || returnUrl.pathname.startsWith("/api/")) {
      return res.status(400).json({ success: false, message: "Invalid Google sign-in return address." });
    }
    // The callback runs through the frontend's /api proxy so its cookie stays first-party.
    const redirectUri = `${returnUrl.origin}/api/auth/google/callback`;
    const state = random();
    const browser = random();
    const nonce = random();
    const verifier = random();
    await Attempt.create({ browserHash: hash(browser), stateHash: hash(state), endpoint, mode,
      returnTo: returnUrl.href, redirectUri, nonce, verifier, expiresAt: new Date(Date.now() + 10 * 60 * 1000) });
    res.cookie(cookieName, browser, { ...cookieOptions(), maxAge: 10 * 60 * 1000 });
    const url = client(redirectUri).generateAuthUrl({ scope: ["openid", "email", "profile"],
      state, nonce, prompt: "select_account", code_challenge: hashChallenge(verifier), code_challenge_method: "S256" });
    return res.json({ success: true, url });
  } catch (error) { next(error); }
});
function hashChallenge(value) { return crypto.createHash("sha256").update(value).digest("base64url"); }

router.get("/callback", async (req, res, next) => {
  try {
    const browser = browserId(req);
    if (!browser || typeof req.query.state !== "string") return res.status(400).send("Google sign-in expired. Return to the login page and try again.");
    // Claim the state once; repeated callbacks cannot exchange the code again.
    const attempt = await Attempt.findOneAndUpdate({ browserHash: hash(browser), stateHash: hash(req.query.state),
      status: "started", expiresAt: { $gt: new Date() } }, { $set: { status: "processing" } }, { returnDocument: "after" });
    if (!attempt) return res.status(400).send("Google sign-in expired. Return to the login page and try again.");
    try {
      if (req.query.error || typeof req.query.code !== "string") throw new Error("Cancelled");
      const oauth = client(attempt.redirectUri);
      const { tokens } = await oauth.getToken({ code: req.query.code, codeVerifier: attempt.verifier, redirect_uri: attempt.redirectUri });
      const ticket = await oauth.verifyIdToken({ idToken: tokens.id_token, audience: process.env.GOOGLE_CLIENT_ID });
      const identity = ticket.getPayload();
      if (!identity?.sub || !identity.email || identity.email_verified !== true || identity.nonce !== attempt.nonce) throw new Error("Invalid identity");
      attempt.credential = encrypt(tokens.id_token);
    } catch {
      attempt.message = req.query.error === "access_denied" ? "Google sign-in was cancelled. Please try again." : "Google sign-in could not be verified. Please try again.";
    }
    attempt.status = "ready";
    attempt.verifier = undefined;
    await attempt.save();
    const target = new URL(attempt.returnTo);
    target.searchParams.set("google_return", "1");
    return res.redirect(303, target.href);
  } catch (error) { next(error); }
});

router.post("/result", requireOrigin, async (req, res, next) => {
  try {
    const browser = browserId(req);
    const attempt = browser && await Attempt.findOneAndDelete({ browserHash: hash(browser), status: "ready", expiresAt: { $gt: new Date() } });
    res.clearCookie(cookieName, cookieOptions());
    if (!attempt || new URL(attempt.returnTo).origin !== req.get("origin")) {
      return res.status(400).json({ success: false, message: "Google sign-in expired. Please try again." });
    }
    if (attempt.message) return res.status(401).json({ success: false, message: attempt.message });
    return res.json({ success: true, endpoint: attempt.endpoint, mode: attempt.mode, credential: decrypt(attempt.credential), nonce: attempt.nonce });
  } catch (error) { next(error); }
});

module.exports = router;
