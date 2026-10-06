const { PartnerProgram } = require("../models/Index");

/* ============================================================
   PUBLIC — ACTIVE PARTNER PROGRAMS
   No auth required. Powers the "join this program" banners on the
   landing/register pages — anyone browsing before they have an
   account needs to be able to see what's currently running.
============================================================ */

const listActivePrograms = async (req, res) => {
  const now = new Date();

  const programs = await PartnerProgram.find({
    status: "active",
    isPublic: true,
    $and: [
      { $or: [{ startDate: { $exists: false } }, { startDate: null }, { startDate: { $lte: now } }] },
      { $or: [{ endDate: { $exists: false } }, { endDate: null }, { endDate: { $gte: now } }] }
    ]
  })
    .select("name code type description bannerHeadline startDate endDate incentive")
    .sort({ endDate: 1 });

  return res.json({ success: true, data: programs });
};

module.exports = { listActivePrograms };
