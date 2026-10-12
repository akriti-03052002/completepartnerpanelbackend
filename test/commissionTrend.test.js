const { test } = require("node:test");
const assert = require("node:assert/strict");
const { trendMonths, fillTrend } = require("../services/commissionTrend");
test("uses twelve consecutive calendar months including months with no earnings", () => {
  const months = trendMonths(new Date("2026-10-12T12:00:00+05:30"));
  assert.equal(months.length, 12);
  assert.equal(months[0], "2025-11");
  assert.equal(months[11], "2026-10");
  const trend = fillTrend(months, [{ _id: { year: 2026, month: 10 }, total: 1250 }, { _id: { year: 2026, month: 8 }, total: 500 }, { _id: { year: 2024, month: 1 }, total: 99999 }]);
  assert.equal(trend[9].total, 500);
  assert.equal(trend[10].total, 0);
  assert.equal(trend[11].total, 1250);
  assert.equal(trend.reduce((sum, row) => sum + row.total, 0), 1750);
});
test("month boundary uses India time rather than UTC", () => {
  const months = trendMonths(new Date("2026-01-31T20:00:00Z"));
  assert.equal(months[11], "2026-02");
  assert.equal(months[0], "2025-03");
  assert.ok(fillTrend(months, []).every(row => row.total === 0));
});
