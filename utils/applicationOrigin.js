const isApplicationOrigin = (origin) => {
  if (!origin) return false;
  const configured = [process.env.CLIENT_URL, ...(process.env.CLIENT_URLS || "").split(",")]
    .filter(Boolean).map(value => value.trim().replace(/\/+$/, ""));
  if (process.env.NODE_ENV !== "production") configured.push("http://localhost:5173", "http://127.0.0.1:5173");
  if (configured.includes(origin)) return true;
  if (!configured.includes("*")) return false;
  try {
    const candidate = new URL(origin);
    const primary = new URL(process.env.CLIENT_URL);
    if (candidate.origin !== origin || candidate.protocol !== "https:" || candidate.port) return false;
    if (!primary.hostname.endsWith(".vercel.app")) return false;
    const project = primary.hostname.slice(0, -".vercel.app".length);
    return candidate.hostname.endsWith(".vercel.app") && candidate.hostname.startsWith(`${project}-`);
  } catch {
    return false;
  }
};

module.exports = isApplicationOrigin;
