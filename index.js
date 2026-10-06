const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
require("dotenv").config();

const connectDB = require("./config/db");
const logger = require("./utils/logger");
const safeRequestPath = require("./utils/safeRequestPath");
const { isCloudinaryConfigured } = require("./utils/fileStorage");

const partnerAuthMiddleware = require("./middleware/partnerAuthMiddleware");
const loadPartnerContext = require("./middleware/loadPartnerContext");
const requireVerifiedPartner = require("./middleware/requireVerifiedPartner");
const requireInfluencerPartner = require("./middleware/requireInfluencerPartner");
const requirePartnerType = require("./middleware/requirePartnerType");
const adminAuthMiddleware = require("./middleware/adminAuthMiddleware");
const customerAuthMiddleware = require("./middleware/customerAuthMiddleware");
const loadCustomerContext = require("./middleware/loadCustomerContext");
const { handleRazorpayWebhook } = require("./controller/razorpayWebhookController");
const { syncAllStaleAccounts } = require("./services/socialSync");
const { startResellerScheduler } = require("./services/resellerScheduler");
const { settleAllApprovedCommissions } = require("./services/autoSettlement");

const partnerAuthRoutes = require("./router/partnerAuthRoutes");
const partnerProgramPublicRoutes = require("./router/partnerProgramPublicRoutes");
const partnerSocialCallbackRoutes = require("./router/partnerSocialCallbackRoutes");
const partnerSocialRoutes = require("./router/partnerSocialRoutes");
const partnerInfluencerRoutes = require("./router/partnerInfluencerRoutes");
const customerPublicRoutes = require("./router/customerPublicRoutes");
const customerRoutes = require("./router/customerRoutes");
const partnerCustomerRoutes = require("./router/partnerCustomerRoutes");
const partnerProfileRoutes = require("./router/partnerProfileRoutes");
const partnerDocumentRoutes = require("./router/partnerDocumentRoutes");
const partnerBankRoutes = require("./router/partnerBankRoutes");
const partnerReferralRoutes = require("./router/partnerReferralRoutes");
const partnerOpportunityRoutes = require("./router/partnerOpportunityRoutes");
const partnerCommissionRoutes = require("./router/partnerCommissionRoutes");
const partnerSettlementRoutes = require("./router/partnerSettlementRoutes");
const partnerNotificationRoutes = require("./router/partnerNotificationRoutes");
const partnerDashboardRoutes = require("./router/partnerDashboardRoutes");
const partnerUserRoutes = require("./router/partnerUserRoutes");
const partnerResellerRoutes = require("./router/partnerResellerRoutes");
const publicResellerCustomerRoutes = require("./router/publicResellerCustomerRoutes");
const customerPortalRoutes = require("./router/customerPortalRoutes");

const adminAuthRoutes = require("./router/adminAuthRoutes");
const adminPartnerRoutes = require("./router/adminPartnerRoutes");
const adminDocumentRoutes = require("./router/adminDocumentRoutes");
const adminBankRoutes = require("./router/adminBankRoutes");
const adminOpportunityRoutes = require("./router/adminOpportunityRoutes");
const adminConfigRoutes = require("./router/adminConfigRoutes");
const adminCommissionRoutes = require("./router/adminCommissionRoutes");
const adminSettlementRoutes = require("./router/adminSettlementRoutes");
const adminCustomerRoutes = require("./router/adminCustomerRoutes");
const adminStatsRoutes = require("./router/adminStatsRoutes");
const adminResellerRoutes = require("./router/adminResellerRoutes");
const adminSocialMediaRoutes = require("./router/adminSocialMediaRoutes");
const adminNotificationRoutes = require("./router/adminNotificationRoutes");
const adminLeadRoutes = require("./router/adminLeadRoutes");

const app = express();

app.set("trust proxy", 1);

/* ==========================================
   MIDDLEWARE
========================================== */

app.use(helmet());

const allowedOrigins = (process.env.CLIENT_URLS || process.env.CLIENT_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim());

app.use(
  cors({
    origin: allowedOrigins
  })
);

// Razorpay webhook: must be mounted with a raw body parser BEFORE the
// global express.json() below — signature verification needs the exact
// raw bytes Razorpay sent, which express.json() would otherwise consume.
app.post("/api/webhooks/razorpay", express.raw({ type: "application/json" }), handleRazorpayWebhook);

app.use(express.json());

// One line per request to the console and backend/logs/<date>.log.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    logger.info(`${req.method} ${safeRequestPath(req.originalUrl)} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

/* ==========================================
   HEALTH CHECK
========================================== */

app.get("/", (req, res) => {
  res.json({ success: true, message: "SPOTX Partner Panel API running" });
});
app.get("/live", (req, res) => res.json({ success: true, status: "alive" }));
app.get("/health", (req, res) => {
  const ready = require("mongoose").connection.readyState === 1;
  res.status(ready ? 200 : 503).json({ success: ready, status: ready ? "ready" : "database_unavailable" });
});

/* ==========================================
   PARTNER ROUTES
   /auth is public; everything else requires a
   valid JWT + a fresh PartnerUser/Partner context.
========================================== */

app.use("/api/partner/auth", partnerAuthRoutes);
app.use("/api/partner/programs", partnerProgramPublicRoutes);
app.use("/api/partner/social", partnerSocialCallbackRoutes);
app.use("/api/public/customers", customerPublicRoutes);
app.use("/api/public/reseller-customers", publicResellerCustomerRoutes);
app.use("/api/customer-portal", customerPortalRoutes);

app.use("/api/customer", customerAuthMiddleware, loadCustomerContext, customerRoutes);

const partnerGuard = [partnerAuthMiddleware, loadPartnerContext];
// Everything a partner needs in order to GET verified stays open; anything
// that presumes verified status (referring, selling, getting paid, adding
// teammates) is locked until then.
const verifiedGuard = [...partnerGuard, requireVerifiedPartner];

// Commission-earning types only — Resellers pay SPOTX for licenses instead
// of earning commission, so they have no commission ledger or payouts.
const earningTypes = requirePartnerType("influencer", "affiliate", "vendor");

app.use("/api/partner/customers", verifiedGuard, requirePartnerType("vendor"), partnerCustomerRoutes);
app.use("/api/partner/profile", partnerGuard, partnerProfileRoutes);
app.use("/api/partner/documents", partnerGuard, partnerDocumentRoutes);
app.use("/api/partner/bank", partnerGuard, partnerBankRoutes);
app.use("/api/partner/referrals", verifiedGuard, requirePartnerType("affiliate"), partnerReferralRoutes);
app.use("/api/partner/opportunities", verifiedGuard, requirePartnerType("affiliate"), partnerOpportunityRoutes);
app.use("/api/partner/commissions", verifiedGuard, earningTypes, partnerCommissionRoutes);
app.use("/api/partner/settlements", verifiedGuard, earningTypes, partnerSettlementRoutes);
app.use("/api/partner/notifications", partnerGuard, partnerNotificationRoutes);
app.use("/api/partner/dashboard", partnerGuard, partnerDashboardRoutes);
app.use("/api/partner/team", verifiedGuard, partnerUserRoutes);
app.use("/api/partner/reseller", verifiedGuard, partnerResellerRoutes);
app.use("/api/partner/social", partnerGuard, requireInfluencerPartner, partnerSocialRoutes);
app.use("/api/partner/social", partnerGuard, requireInfluencerPartner, partnerInfluencerRoutes);

/* ==========================================
   ADMIN ROUTES
   /auth is public; everything else requires a
   valid admin JWT (fully separate secret/model).
========================================== */

app.use("/api/admin/auth", adminAuthRoutes);

app.use("/api/admin/partners", adminAuthMiddleware, adminPartnerRoutes);
app.use("/api/admin/documents", adminAuthMiddleware, adminDocumentRoutes);
app.use("/api/admin/bank", adminAuthMiddleware, adminBankRoutes);
app.use("/api/admin/opportunities", adminAuthMiddleware, adminOpportunityRoutes);
app.use("/api/admin/config", adminAuthMiddleware, adminConfigRoutes);
app.use("/api/admin/commissions", adminAuthMiddleware, adminCommissionRoutes);
app.use("/api/admin/settlements", adminAuthMiddleware, adminSettlementRoutes);
app.use("/api/admin/customers", adminAuthMiddleware, adminCustomerRoutes);
app.use("/api/admin/stats", adminAuthMiddleware, adminStatsRoutes);
app.use("/api/admin/reseller", adminAuthMiddleware, adminResellerRoutes);
app.use("/api/admin/social-media", adminAuthMiddleware, adminSocialMediaRoutes);
app.use("/api/admin/notifications", adminAuthMiddleware, adminNotificationRoutes);
app.use("/api/admin/leads", adminAuthMiddleware, adminLeadRoutes);

/* ==========================================
   404 + ERROR HANDLER
========================================== */

app.use((req, res) => {
  res.status(404).json({ success: false, message: "Route not found." });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  // A rejected upload (wrong file type, over 5MB, unexpected field) is the
  // caller's mistake, not a server fault.
  const isUploadError = error.name === "MulterError" || error.message === "Only PDF, PNG and JPG files are allowed.";
  if (isUploadError) {
    return res.status(400).json({
      success: false,
      message: error.code === "LIMIT_FILE_SIZE" ? "File is too large — the limit is 5MB." : error.message
    });
  }

  // A malformed id in the URL (/partners/abc) is "not found", not a crash.
  if (error.name === "CastError" && error.kind === "ObjectId") {
    return res.status(404).json({ success: false, message: "Not found." });
  }

  logger.error("Unhandled error:", error);

  res.status(error.status || error.statusCode || 500).json({
    success: false,
    message: (error.status || error.statusCode || 500) >= 500 && process.env.NODE_ENV !== "development" ? "Something went wrong." : error.message || "Something went wrong.",
    error: process.env.NODE_ENV === "development" ? error.stack : undefined
  });
});

/* ==========================================
   START
========================================== */

const PORT = process.env.PORT || 5000;

const start = () => connectDB().then(() => {
  const server = app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    if (!isCloudinaryConfigured()) {
      logger.error("Cloudinary isn't configured (CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET) — document uploads and agreement generation will fail until it is.");
    }
  });

  // Each licence purchase now has its own invoices, so two invoices for one
  // reseller can cover the same dates. The old unique index forbade that.
  require("mongoose").connection.collection("resellerinvoices")
    .dropIndex("partnerId_1_billingPeriodStart_1_billingPeriodEnd_1")
    .then(() => logger.info("Dropped the old per-period reseller invoice index."))
    .catch(() => {}); // already gone, or the collection doesn't exist yet

  const stopResellerScheduler = startResellerScheduler();

  // Commissions approved before settlements became automatic get theirs now.
  settleAllApprovedCommissions()
    .then((count) => { if (count) logger.info(`Opened settlements for ${count} previously approved commission(s).`); })
    .catch((error) => logger.error("Settling previously approved commissions failed:", error));
  const runSocialSync = () => syncAllStaleAccounts().catch((error) => console.error("Social sync failed:", error.message));
  runSocialSync();
  const socialTimer = setInterval(runSocialSync, 6 * 60 * 60 * 1000);
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopResellerScheduler();
    clearInterval(socialTimer);
    const timeout = setTimeout(() => process.exit(1), 30000);
    timeout.unref();
    server.close(async () => {
      await require("mongoose").disconnect();
      clearTimeout(timeout);
      process.exit(0);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
});

// Started directly (npm start / nodemon) it boots the server; required from
// a test it only hands back the Express app, so tests can drive the API
// against their own throwaway database without opening a port or starting
// the schedulers.
if (require.main === module) start();

module.exports = app;
