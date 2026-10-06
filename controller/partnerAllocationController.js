const CustomerAllocation = require("../models/CustomerAllocation");
const ResellerCustomer = require("../models/ResellerCustomer");
const Screen = require("../models/Screen");
const resellerInventory = require("../services/resellerInventory");
const logActivity = require("../utils/logActivity");
const asyncHandler = require("express-async-handler");

/* ============================================================
   PARTNER — CUSTOMER ALLOCATION (RESELLER)
   Allocate / release / suspend / reactivate / cancel — each a
   distinct, separately-billed-irrelevant state transition. Every inventory-count change
   routes through services/resellerInventory.js; this controller
   only ever updates CustomerAllocation/ResellerCustomer/Screen
   status alongside it.

   Allocation only grants license CAPACITY — it no longer creates or
   activates any Screen. The customer registers their own screens one
   at a time from the customer portal (see
   publicResellerCustomerController.registerMyScreen), up to
   allocatedLicenses; that's the only place Screen docs get created
   and the only place registerScreens/activateScreens get called now.
============================================================ */

const findAllocation = async (req) => {
  return CustomerAllocation.findOne({ _id: req.params.id, partnerId: req.partner._id });
};

const listAllocations = asyncHandler(async (req, res) => {
  const allocations = await CustomerAllocation.find({ partnerId: req.partner._id })
    .populate("customerId", "businessDetails.companyName status")
    .sort({ createdAt: -1 });
  return res.json({ success: true, data: allocations });
});

const allocateLicenses = asyncHandler(async (req, res) => {
  try {
    const { customerId, screens } = req.body;
    const quantity = parseInt(screens, 10);

    if (!customerId || !quantity || quantity < 1) {
      return res.status(400).json({ success: false, message: "customerId and a valid screens quantity are required." });
    }

    const customer = await ResellerCustomer.findOne({ _id: customerId, partnerId: req.partner._id });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found." });
    }

    await resellerInventory.allocate({
      partnerId: req.partner._id,
      customerId,
      quantity,
      createdBy: req.partnerUser._id
    });

    let allocation = await CustomerAllocation.findOne({ partnerId: req.partner._id, customerId, status: { $ne: "cancelled" } });

    if (allocation) {
      allocation.allocatedLicenses += quantity;
    } else {
      allocation = new CustomerAllocation({
        partnerId: req.partner._id,
        customerId,
        allocatedLicenses: quantity,
        status: "allocated"
      });
    }

    // Capacity only — no Screen is created and no registered/active count
    // moves here. The customer registers each physical screen themselves
    // (see registerMyScreen), up to this allocatedLicenses ceiling.
    await allocation.save();

    // A customer only counts as "active" once they've actually registered
    // a screen — allocating capacity alone shouldn't flip their status.
    if (customer.status === "pending") {
      customer.status = "allocated";
      await customer.save();
    }

    await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "license_allocated",
      entityType: "CustomerAllocation",
      entityId: allocation._id,
      description: `${quantity} licenses allocated to ${customer.businessDetails.companyName} — they can now register that many screens from their portal.`,
      req
    });

    return res.status(201).json({ success: true, message: "Licenses allocated.", data: allocation });
  } catch (error) {
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error("allocateLicenses error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong allocating licenses." });
  }
});

const releaseLicenses = asyncHandler(async (req, res) => {
  const allocation = await findAllocation(req);
  if (!allocation) return res.status(404).json({ success: false, message: "Allocation not found." });

  const quantity = parseInt(req.body.screens, 10);
  if (!quantity || quantity < 1 || quantity > allocation.allocatedLicenses) {
    return res.status(400).json({ success: false, message: "Enter a valid number of screens to release." });
  }

  const newAllocated = allocation.allocatedLicenses - quantity;
  const newRegistered = Math.min(allocation.registeredScreens, newAllocated);
  const newActive = Math.min(allocation.activeScreens, newRegistered);
  const newSuspended = Math.min(allocation.suspendedScreens, newRegistered);

  await resellerInventory.release({
      partnerId: req.partner._id,
      customerId: allocation.customerId,
      allocationId: allocation._id,
      quantity,
      registeredDelta: allocation.registeredScreens - newRegistered,
      activeDelta: allocation.activeScreens - newActive,
      suspendedDelta: allocation.suspendedScreens - newSuspended,
      createdBy: req.partnerUser._id
    });

  allocation.allocatedLicenses = newAllocated;
  allocation.registeredScreens = newRegistered;
  allocation.activeScreens = newActive;
  allocation.suspendedScreens = newSuspended;
  await allocation.save();

  await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "license_released",
      entityType: "CustomerAllocation",
      entityId: allocation._id,
      description: `${quantity} licenses released back to inventory.`,
      req
    });

  return res.json({ success: true, message: "Licenses released.", data: allocation });
});

// Reseller-discretionary — intended for when their own customer stops
// paying THEM. SPOTX has no
// visibility into or approval role over this action.
const suspendCustomer = asyncHandler(async (req, res) => {
  const allocation = await findAllocation(req);
  if (!allocation) return res.status(404).json({ success: false, message: "Allocation not found." });

  const quantity = req.body.screens ? parseInt(req.body.screens, 10) : allocation.activeScreens;

  await resellerInventory.suspendScreens({
      partnerId: req.partner._id,
      customerId: allocation.customerId,
      allocationId: allocation._id,
      quantity,
      createdBy: req.partnerUser._id
    });

  allocation.activeScreens -= Math.min(quantity, allocation.activeScreens);
  allocation.suspendedScreens += quantity;
  allocation.status = "suspended";
  await allocation.save();

  await Screen.updateMany(
    { allocationId: allocation._id, licenseStatus: "active" },
    { $set: { licenseStatus: "suspended", suspendedAt: new Date() } },
    { limit: quantity }
  );
  await ResellerCustomer.findByIdAndUpdate(allocation.customerId, { status: "suspended" });

  await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "screen_suspended",
      entityType: "CustomerAllocation",
      entityId: allocation._id,
      description: `Customer suspended by partner — ${quantity} screens paused. License remains reserved and billed.`,
      req
    });

  return res.json({ success: true, message: "Customer suspended.", data: allocation });
});

const reactivateCustomer = asyncHandler(async (req, res) => {
  const allocation = await findAllocation(req);
  if (!allocation) return res.status(404).json({ success: false, message: "Allocation not found." });

  const quantity = req.body.screens ? parseInt(req.body.screens, 10) : allocation.suspendedScreens;

  await resellerInventory.reactivateScreens({
      partnerId: req.partner._id,
      customerId: allocation.customerId,
      allocationId: allocation._id,
      quantity,
      createdBy: req.partnerUser._id
    });

  allocation.suspendedScreens -= Math.min(quantity, allocation.suspendedScreens);
  allocation.activeScreens += quantity;
  allocation.status = "active";
  await allocation.save();

  await Screen.updateMany(
    { allocationId: allocation._id, licenseStatus: "suspended" },
    { $set: { licenseStatus: "active", suspendedAt: null } },
    { limit: quantity }
  );
  await ResellerCustomer.findByIdAndUpdate(allocation.customerId, { status: "active" });

  await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "screen_reactivated",
      entityType: "CustomerAllocation",
      entityId: allocation._id,
      description: `${quantity} screens reactivated.`,
      req
    });

  return res.json({ success: true, message: "Customer reactivated.", data: allocation });
});

const cancelAllocation = asyncHandler(async (req, res) => {
  const allocation = await findAllocation(req);
  if (!allocation) return res.status(404).json({ success: false, message: "Allocation not found." });

  const quantity = allocation.allocatedLicenses;

  await resellerInventory.release({
      partnerId: req.partner._id,
      customerId: allocation.customerId,
      allocationId: allocation._id,
      quantity,
      registeredDelta: allocation.registeredScreens,
      activeDelta: allocation.activeScreens,
      suspendedDelta: allocation.suspendedScreens,
      type: "cancellation",
      createdBy: req.partnerUser._id
    });

  allocation.allocatedLicenses = 0;
  allocation.registeredScreens = 0;
  allocation.activeScreens = 0;
  allocation.suspendedScreens = 0;
  allocation.status = "cancelled";
  allocation.releasedAt = new Date();
  await allocation.save();

  await Screen.updateMany(
    { allocationId: allocation._id, licenseStatus: { $ne: "cancelled" } },
    { $set: { licenseStatus: "cancelled", cancelledAt: new Date() } }
  );
  await ResellerCustomer.findByIdAndUpdate(allocation.customerId, { status: "cancelled" });

  await logActivity({
      partnerId: req.partner._id,
      performedByType: "partner_user",
      performedByUserId: req.partnerUser._id,
      activityType: "license_cancelled",
      entityType: "CustomerAllocation",
      entityId: allocation._id,
      description: `Allocation cancelled — ${quantity} licenses returned to inventory. Purchased licenses unaffected.`,
      req
    });

  return res.json({ success: true, message: "Allocation cancelled.", data: allocation });
});

module.exports = {
  listAllocations,
  allocateLicenses,
  releaseLicenses,
  suspendCustomer,
  reactivateCustomer,
  cancelAllocation
};
