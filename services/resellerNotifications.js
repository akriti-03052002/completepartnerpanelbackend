const Partner = require("../models/Partner");
const ResellerInventory = require("../models/ResellerInventory");
const ResellerBillingConfig = require("../models/ResellerBillingConfig");
const ResellerInvoice = require("../models/ResellerInvoice");
const PartnerNotification = require("../models/Partnernotification");
const logActivity = require("../utils/logActivity");

/* ============================================================
   RESELLER NOTIFICATIONS
   Manual-trigger companion to services/resellerBilling.js — same
   reasoning as that file's "no scheduler yet" note (B12 item 1).
   Run via adminResellerController.checkNotifications (and
   automatically at the end of a billing run). Reuses the existing
   PartnerNotification mechanism already used elsewhere in the
   panel — no new model.

   Three checks:
   1. Due-date reminder — dueDateReminderDaysBefore before an unpaid
      invoice's dueDate.
   2. Low-inventory alert — available licenses at or below
      lowInventoryNotificationThresholdPercent of purchased.
   3. Agreement-expiring — admin-facing only (a PartnerActivity
      entry, not a PartnerNotification — this alerts SPOTX, not the
      partner).

   Each check is deduplicated by looking for an existing
   notification/activity created within the relevant window, so
   running this repeatedly (e.g. once a day via an admin click)
   never spams the same partner.
============================================================ */

const DAY_MS = 24 * 60 * 60 * 1000;
const AGREEMENT_EXPIRY_LOOKAHEAD_DAYS = 30;

const hasRecentNotification = async (partnerId, type, withinDays) => {
  const since = new Date(Date.now() - withinDays * DAY_MS);
  const existing = await PartnerNotification.findOne({ partnerId, type, createdAt: { $gte: since } });
  return Boolean(existing);
};

const checkDueDateReminders = async () => {
  const configs = await ResellerBillingConfig.find();
  let sent = 0;

  for (const config of configs) {
    const reminderWindowStart = new Date(Date.now() + config.dueDateReminderDaysBefore * DAY_MS);

    const dueSoonInvoices = await ResellerInvoice.find({
      partnerId: config.partnerId,
      paymentStatus: { $in: ["pending", "failed"] },
      dueDate: { $gte: new Date(), $lte: reminderWindowStart }
    });

    for (const invoice of dueSoonInvoices) {
      const alreadySent = await PartnerNotification.findOne({
        partnerId: config.partnerId,
        type: "reseller_invoice_due_reminder",
        "entity.entityId": invoice._id
      });
      if (alreadySent) continue;

      await PartnerNotification.create({
        partnerId: config.partnerId,
        type: "reseller_invoice_due_reminder",
        title: "Invoice due soon",
        message: `Invoice ${invoice.invoiceNumber} for ${invoice.total} is due on ${invoice.dueDate.toDateString()}.`,
        entity: { type: "ResellerInvoice", entityId: invoice._id }
      });
      sent += 1;
    }
  }

  return sent;
};

const checkLowInventoryAlerts = async () => {
  const partners = await Partner.find({ partnerType: "reseller" }).select("_id");
  let sent = 0;

  for (const partner of partners) {
    const [inventory, config] = await Promise.all([
      ResellerInventory.findOne({ partnerId: partner._id }),
      ResellerBillingConfig.findOne({ partnerId: partner._id })
    ]);

    if (!inventory || !inventory.totalPurchasedLicenses) continue;

    const available = Math.max(0, inventory.totalPurchasedLicenses - inventory.totalAllocatedLicenses);
    const thresholdPercent = config?.lowInventoryNotificationThresholdPercent ?? 10;
    const thresholdCount = (inventory.totalPurchasedLicenses * thresholdPercent) / 100;

    if (available > thresholdCount) continue;

    // Don't re-notify daily while the partner stays under threshold —
    // once every 3 days is enough to be useful without being noisy.
    if (await hasRecentNotification(partner._id, "reseller_low_inventory", 3)) continue;

    await PartnerNotification.create({
      partnerId: partner._id,
      type: "reseller_low_inventory",
      title: "Running low on available licenses",
      message: `Only ${available} of your ${inventory.totalPurchasedLicenses} purchased licenses remain available. Consider buying more before your next allocation.`
    });
    sent += 1;
  }

  return sent;
};

const checkAgreementExpiring = async () => {
  const lookahead = new Date(Date.now() + AGREEMENT_EXPIRY_LOOKAHEAD_DAYS * DAY_MS);

  const configs = await ResellerBillingConfig.find({
    agreementEndDate: { $ne: null, $gte: new Date(), $lte: lookahead }
  });

  let flagged = 0;

  for (const config of configs) {
    // Admin-facing only — logged as a PartnerActivity (visible on the
    // partner's admin detail page), never a PartnerNotification, since
    // this alerts SPOTX, not the partner (B15 item 3).
    const recentlyFlagged = await require("../models/Index")
      .PartnerActivity.findOne({
        partnerId: config.partnerId,
        activityType: "reseller_agreement_expiring",
        createdAt: { $gte: new Date(Date.now() - 7 * DAY_MS) }
      });
    if (recentlyFlagged) continue;

    await logActivity({
      partnerId: config.partnerId,
      performedByType: "system",
      activityType: "reseller_agreement_expiring",
      entityType: "ResellerBillingConfig",
      entityId: config._id,
      description: `This Reseller's agreement ends ${config.agreementEndDate.toDateString()} — contact them to renew, upgrade, or confirm suspension.`
    });
    flagged += 1;
  }

  return flagged;
};

const runResellerNotificationChecks = async () => {
  const [dueDateReminders, lowInventoryAlerts, agreementExpiringFlags] = await Promise.all([
    checkDueDateReminders(),
    checkLowInventoryAlerts(),
    checkAgreementExpiring()
  ]);

  return { dueDateReminders, lowInventoryAlerts, agreementExpiringFlags };
};

module.exports = {
  checkDueDateReminders, checkLowInventoryAlerts, checkAgreementExpiring,
  runResellerNotificationChecks
};
