const ResellerInventory = require("../models/ResellerInventory");
const LicenseTransaction = require("../models/LicenseTransaction");

/* ============================================================
   RESELLER INVENTORY SERVICE
   The ONLY code path allowed to mutate ResellerInventory. Every
   operation is a single atomic findOneAndUpdate with the business
   invariant baked directly into the filter (Mongo's per-document
   atomicity, not a multi-document session/transaction — this
   codebase doesn't run against a replica set, so $expr-guarded
   single-document updates are the safe equivalent of the
   check-then-write pattern CustomerPayment already relies on
   elsewhere), immediately followed by one LicenseTransaction ledger
   row. If the ledger write fails after a successful inventory
   update, the inventory numbers are still correct — only the
   history entry would be missing, which is a much smaller blast
   radius than a lost invariant.

   Invariants enforced here, always:
     totalAvailableLicenses (purchased - allocated) >= 0
     totalAllocatedLicenses <= totalPurchasedLicenses
     totalRegisteredScreens <= totalAllocatedLicenses
     totalActiveScreens <= totalRegisteredScreens
     totalSuspendedScreens <= totalRegisteredScreens

   None of these gate billing — billing (services/resellerBilling.js)
   reads only totalPurchasedLicenses.
============================================================ */

class InsufficientLicensesError extends Error {
  constructor(available, requested) {
    super(`Insufficient available screen licenses. Available: ${available}. Requested: ${requested}.`);
    this.statusCode = 400;
    this.available = available;
    this.requested = requested;
  }
}

const getOrCreateInventory = async (partnerId) => {
  let inventory = await ResellerInventory.findOne({ partnerId });
  if (!inventory) {
    inventory = await ResellerInventory.create({ partnerId });
  }
  return inventory;
};

const recordTransaction = async ({ partnerId, customerId, allocationId, purchaseOrderId, type, quantity, previousBalance, newBalance, reason, createdBy }) => {
  await LicenseTransaction.create({
    partnerId,
    customerId,
    allocationId,
    purchaseOrderId,
    type,
    quantity,
    previousBalance,
    newBalance,
    reason,
    createdBy
  });
};

/* Applies a paid ScreenLicensePurchaseOrder — increases purchased
   (and therefore available) licenses. Idempotent via the order's own
   licensesApplied flag, checked by the caller before invoking this. */
const applyPurchase = async ({ partnerId, quantity, purchaseOrderId, createdBy }) => {
  await getOrCreateInventory(partnerId);

  const before = await ResellerInventory.findOne({ partnerId });
  const previousBalance = before.totalPurchasedLicenses;

  const updated = await ResellerInventory.findOneAndUpdate(
    { partnerId },
    { $inc: { totalPurchasedLicenses: quantity } },
    { new: true }
  );

  await recordTransaction({
    partnerId,
    purchaseOrderId,
    type: "purchase",
    quantity,
    previousBalance,
    newBalance: updated.totalPurchasedLicenses,
    reason: "Bulk screen license purchase",
    createdBy
  });

  return updated;
};

/* Reserves `quantity` licenses for a customer. Rejects atomically if it
   would push allocated past purchased. */
const allocate = async ({ partnerId, customerId, allocationId, quantity, createdBy }) => {
  const before = await ResellerInventory.findOne({ partnerId });
  if (!before) throw new InsufficientLicensesError(0, quantity);

  const updated = await ResellerInventory.findOneAndUpdate(
    {
      partnerId,
      $expr: { $lte: [{ $add: ["$totalAllocatedLicenses", quantity] }, "$totalPurchasedLicenses"] }
    },
    { $inc: { totalAllocatedLicenses: quantity } },
    { new: true }
  );

  if (!updated) {
    const available = Math.max(0, before.totalPurchasedLicenses - before.totalAllocatedLicenses);
    throw new InsufficientLicensesError(available, quantity);
  }

  await recordTransaction({
    partnerId,
    customerId,
    allocationId,
    type: "allocation",
    quantity: -quantity,
    previousBalance: before.totalAllocatedLicenses,
    newBalance: updated.totalAllocatedLicenses,
    reason: "Allocated to customer",
    createdBy
  });

  return updated;
};

/* Releases `quantity` previously-allocated licenses back to available —
   used by both a partial reduction and a full cancellation. */
// registeredDelta/activeDelta/suspendedDelta: how much of THIS allocation's
// registered/active/suspended counts are being given up along with the
// released licenses (computed by the caller against the specific
// CustomerAllocation — see partnerAllocationController.releaseLicenses).
// Without decrementing these too, the aggregate totals would drift ahead
// of what's actually allocated, and could wrongly block a completely
// different customer's future registration (totalRegisteredScreens <=
// totalAllocatedLicenses is a partner-wide invariant, not per-customer).
const release = async ({ partnerId, customerId, allocationId, quantity, registeredDelta = 0, activeDelta = 0, suspendedDelta = 0, type = "release", reason, createdBy }) => {
  const before = await ResellerInventory.findOne({ partnerId });
  if (!before) throw new Error("Reseller inventory not found.");

  const updated = await ResellerInventory.findOneAndUpdate(
    { partnerId },
    {
      $inc: {
        totalAllocatedLicenses: -Math.min(quantity, before.totalAllocatedLicenses),
        totalRegisteredScreens: -Math.min(registeredDelta, before.totalRegisteredScreens),
        totalActiveScreens: -Math.min(activeDelta, before.totalActiveScreens),
        totalSuspendedScreens: -Math.min(suspendedDelta, before.totalSuspendedScreens)
      }
    },
    { new: true }
  );

  await recordTransaction({
    partnerId,
    customerId,
    allocationId,
    type,
    quantity,
    previousBalance: before.totalAllocatedLicenses,
    newBalance: updated.totalAllocatedLicenses,
    reason: reason || (type === "cancellation" ? "Customer allocation cancelled" : "Licenses released"),
    createdBy
  });

  return updated;
};

const registerScreens = async ({ partnerId, customerId, allocationId, quantity, createdBy }) => {
  const before = await ResellerInventory.findOne({ partnerId });
  if (!before) throw new Error("Reseller inventory not found.");

  const updated = await ResellerInventory.findOneAndUpdate(
    {
      partnerId,
      $expr: { $lte: [{ $add: ["$totalRegisteredScreens", quantity] }, "$totalAllocatedLicenses"] }
    },
    { $inc: { totalRegisteredScreens: quantity } },
    { new: true }
  );

  if (!updated) {
    throw new Error("Cannot register more screens than currently allocated to this customer.");
  }

  await recordTransaction({
    partnerId,
    customerId,
    allocationId,
    type: "registration",
    quantity,
    previousBalance: before.totalRegisteredScreens,
    newBalance: updated.totalRegisteredScreens,
    reason: "Screen+software bundle delivered to customer",
    createdBy
  });

  return updated;
};

const activateScreens = async ({ partnerId, customerId, allocationId, quantity, createdBy }) => {
  const before = await ResellerInventory.findOne({ partnerId });
  if (!before) throw new Error("Reseller inventory not found.");

  const updated = await ResellerInventory.findOneAndUpdate(
    {
      partnerId,
      $expr: { $lte: [{ $add: ["$totalActiveScreens", quantity] }, "$totalRegisteredScreens"] }
    },
    { $inc: { totalActiveScreens: quantity } },
    { new: true }
  );

  if (!updated) {
    throw new Error("Cannot activate more screens than currently registered for this customer.");
  }

  await recordTransaction({
    partnerId,
    customerId,
    allocationId,
    type: "activation",
    quantity,
    previousBalance: before.totalActiveScreens,
    newBalance: updated.totalActiveScreens,
    reason: "Screen activated — customer subscription starts now, no trial",
    createdBy
  });

  return updated;
};

const suspendScreens = async ({ partnerId, customerId, allocationId, quantity, createdBy }) => {
  const before = await ResellerInventory.findOne({ partnerId });
  if (!before) throw new Error("Reseller inventory not found.");

  const dec = Math.min(quantity, before.totalActiveScreens);

  const updated = await ResellerInventory.findOneAndUpdate(
    { partnerId },
    {
      $inc: {
        totalActiveScreens: -dec,
        totalSuspendedScreens: dec
      }
    },
    { new: true }
  );

  await recordTransaction({
    partnerId,
    customerId,
    allocationId,
    type: "suspension",
    quantity: dec,
    previousBalance: before.totalActiveScreens,
    newBalance: updated.totalActiveScreens,
    reason: "Customer screen suspended by Reseller — license remains reserved and billed",
    createdBy
  });

  return updated;
};

const reactivateScreens = async ({ partnerId, customerId, allocationId, quantity, createdBy }) => {
  const before = await ResellerInventory.findOne({ partnerId });
  if (!before) throw new Error("Reseller inventory not found.");

  const dec = Math.min(quantity, before.totalSuspendedScreens);

  const updated = await ResellerInventory.findOneAndUpdate(
    { partnerId },
    {
      $inc: {
        totalSuspendedScreens: -dec,
        totalActiveScreens: dec
      }
    },
    { new: true }
  );

  await recordTransaction({
    partnerId,
    customerId,
    allocationId,
    type: "reactivation",
    quantity: dec,
    previousBalance: before.totalSuspendedScreens,
    newBalance: updated.totalSuspendedScreens,
    reason: "Customer screen reactivated",
    createdBy
  });

  return updated;
};

/* Superadmin-only manual correction — always logged with a reason. */
const adjust = async ({ partnerId, quantity, reason, createdBy }) => {
  if (!reason) throw new Error("A reason is required for a manual inventory adjustment.");

  const before = await getOrCreateInventory(partnerId);

  const updated = await ResellerInventory.findOneAndUpdate(
    { partnerId },
    { $inc: { totalPurchasedLicenses: quantity } },
    { new: true }
  );

  await recordTransaction({
    partnerId,
    type: "adjustment",
    quantity,
    previousBalance: before.totalPurchasedLicenses,
    newBalance: updated.totalPurchasedLicenses,
    reason,
    createdBy
  });

  return updated;
};

module.exports = {
  InsufficientLicensesError,
  getOrCreateInventory,
  applyPurchase,
  allocate,
  release,
  registerScreens,
  activateScreens,
  suspendScreens,
  reactivateScreens,
  adjust
};
