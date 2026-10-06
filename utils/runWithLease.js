const crypto = require("crypto");
const JobLease = require("../models/JobLease");

module.exports = async (name, task) => {
  const owner = crypto.randomUUID();
  const duration = 5 * 60000;
  try {
    await JobLease.findOneAndUpdate({ _id: name, expiresAt: { $lte: new Date() } },
      { $set: { owner, expiresAt: new Date(Date.now() + duration) } }, { upsert: true });
  } catch (error) {
    if (error.code === 11000) return { skipped: true };
    throw error;
  }
  const timer = setInterval(() => {
    JobLease.updateOne({ _id: name, owner }, { $set: { expiresAt: new Date(Date.now() + duration) } })
      .catch((error) => console.error("Job lease renewal failed:", error.message));
  }, 60000);
  timer.unref();
  try { return await task(); }
  finally {
    clearInterval(timer);
    await JobLease.deleteOne({ _id: name, owner });
  }
};
