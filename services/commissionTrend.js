const PartnerCommission = require("../models/Partnercommission");
const TIMEZONE = "Asia/Kolkata";

function trendMonths(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: TIMEZONE, year: "numeric", month: "numeric" }).formatToParts(now);
  const year = Number(parts.find(part => part.type === "year").value);
  const month = Number(parts.find(part => part.type === "month").value);
  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 12 + index, 1));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}
function fillTrend(months, rows) {
  const totals = new Map(rows.map(row => [`${row._id.year}-${String(row._id.month).padStart(2, "0")}`, row.total]));
  return months.map(period => ({ period, total: Number(totals.get(period) || 0) }));
}
async function commissionTrend(partnerId, now = new Date()) {
  const months = trendMonths(now);
  const rows = await PartnerCommission.aggregate([
    { $match: { partnerId, "settlement.status": { $ne: "cancelled" }, createdAt: { $gte: new Date(`${months[0]}-01T00:00:00+05:30`), $lte: now } } },
    { $group: { _id: { year: { $year: { date: "$createdAt", timezone: TIMEZONE } }, month: { $month: { date: "$createdAt", timezone: TIMEZONE } } }, total: { $sum: "$calculation.netCommission" } } }
  ]);
  return fillTrend(months, rows);
}
module.exports = { commissionTrend, trendMonths, fillTrend };
