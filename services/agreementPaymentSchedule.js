module.exports = (setting) => {
  if (!setting) return "Payout cycle: not configured.";
  const cycle = setting.settlementType || "manual";
  return `Payout cycle: ${cycle}${setting.status === "inactive" ? " (inactive)" : ""}.`;
};
