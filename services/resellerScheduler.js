const runWithLease = require("../utils/runWithLease");
const { runBillingForAllPartners, markOverdueInvoices } = require("./resellerBilling");
const { runResellerNotificationChecks } = require("./resellerNotifications");

/* ============================================================
   RESELLER SCHEDULER
   Everything in resellerBilling.js/resellerNotifications.js was
   built "manual for this release" (admin clicks "Run Billing Now" /
   "Check Notifications") specifically so it could be wired to a
   timer later with zero change to the underlying logic — this file
   is that timer. No new dependency: the app is a long-running Node
   process (not serverless), so a plain setInterval is enough —
   no need for node-cron to check every fifteen minutes.

   Runs the same three admin-triggered jobs, in the same order
   runBillingNow does: generate any due invoices, mark overdue ones,
   then run the notification checks (due-date reminders,
   low-inventory alerts, agreement-expiring flags, and inactive-
   partner marking). All three are idempotent — safe to run repeatedly
   even on days nothing is actually due, and safe if the admin also
   clicks the manual buttons in between runs.
============================================================ */

const RUN_INTERVAL_MS = 15 * 60 * 1000;

const executeResellerJob = async () => {
  try {
    const results = await runBillingForAllPartners({});
    const overdueMarked = await markOverdueInvoices();
    const notifications = await runResellerNotificationChecks();

    console.log(
      `[resellerScheduler] Run complete — ${results.length} partner(s) checked for billing, ` +
      `${overdueMarked} invoice(s) marked overdue, ` +
      `${notifications.dueDateReminders} due-date reminder(s), ` +
      `${notifications.lowInventoryAlerts} low-inventory alert(s), ` +
      `${notifications.agreementExpiringFlags} agreement-expiring flag(s).`
    );
  } catch (error) {
    console.error("[resellerScheduler] Run failed:", error);
  }
};

const runResellerDailyJob = () => runWithLease("reseller-billing", executeResellerJob).catch((error) => console.error("Reseller job failed:", error.message));

// Called once from index.js after the DB connects. Runs once shortly
// after startup (so a server that was down over a cycle boundary
// catches up quickly) and then every fifteen minutes. The shared
// database lease also covers manual admin runs and other processes.
const startResellerScheduler = () => {
  const initial = setTimeout(runResellerDailyJob, 60 * 1000);
  const interval = setInterval(runResellerDailyJob, RUN_INTERVAL_MS);
  console.log("[resellerScheduler] Started — reseller billing/notifications will run automatically every 15 minutes.");
  return () => { clearTimeout(initial); clearInterval(interval); };
};

module.exports = { startResellerScheduler, runResellerDailyJob };
