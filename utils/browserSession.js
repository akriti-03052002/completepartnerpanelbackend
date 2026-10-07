const names = { partner: "spotx_partner", admin: "spotx_admin", customer: "spotx_customer", portal: "spotx_portal" };
const options = () => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api" });
const issueSession = (req, res, portal, token) => {
  if (req.get("X-Session-Mode") !== "cookie") return token;
  res.cookie(names[portal], token, { ...options(), maxAge: (portal === "admin" ? 12 * 3600 : portal === "portal" ? 30 * 86400 : 86400) * 1000 });
  return undefined;
};
const cookies = (req) => Object.fromEntries((req.headers.cookie || "").split(";").map(part => { const i = part.indexOf("="); return i < 0 ? ["", ""] : [part.slice(0, i).trim(), part.slice(i + 1)]; }));
const browserSession = (req, res, next) => {
  const stored = cookies(req);
  const usesCookies = Object.values(names).some(name => stored[name]);
  if ((usesCookies || req.get("X-Session-Mode") === "cookie") && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const allowed = [process.env.CLIENT_URL, ...(process.env.CLIENT_URLS || "").split(","), ...(process.env.NODE_ENV !== "production" ? ["http://localhost:5173", "http://127.0.0.1:5173"] : [])].filter(Boolean).filter(origin => origin !== "*").map(origin => origin.trim().replace(/\/+$/, ""));
    if (!allowed.includes(req.get("origin"))) return res.status(403).json({ success: false, message: "This request must come from an allowed application origin." });
  }
  if (!req.headers.authorization) {
    const portal = req.path.startsWith("/api/admin/") ? "admin" : req.path.startsWith("/api/customer-portal/") ? "portal" : req.path.startsWith("/api/customer/") ? "customer" : req.path.startsWith("/api/partner/") ? "partner" : null;
    if (portal && stored[names[portal]]) req.headers.authorization = `Bearer ${stored[names[portal]]}`;
  }
  next();
};
const logout = (req, res) => {
  if (!names[req.body.portal]) return res.status(400).json({ success: false, message: "Invalid portal." });
  res.clearCookie(names[req.body.portal], options());
  return res.json({ success: true });
};
module.exports = { issueSession, browserSession, logout };
