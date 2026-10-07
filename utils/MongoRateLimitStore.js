const Counter = require("../models/RateLimitCounter");
// Atomic updates share each limiter's counters across API instances.
module.exports = class MongoRateLimitStore {
  constructor(prefix) { this.prefix = prefix + ":"; this.localKeys = false; }
  init(options) { this.windowMs = options.windowMs; }
  async increment(key) {
    const now = new Date();
    const expired = { $lte: [{ $ifNull: ["$resetTime", new Date(0)] }, now] };
    const update = [{ $set: {
      hits: { $cond: [expired, 1, { $add: [{ $ifNull: ["$hits", 0] }, 1] }] },
      resetTime: { $cond: [expired, new Date(now.getTime() + this.windowMs), "$resetTime"] }
    } }];
    const options = { upsert: true, new: true, updatePipeline: true };
    let counter;
    try { counter = await Counter.findOneAndUpdate({ _id: this.prefix + key }, update, options).lean(); }
    catch (error) {
      if (error.code !== 11000) throw error;
      counter = await Counter.findOneAndUpdate({ _id: this.prefix + key }, update, options).lean();
    }
    return { totalHits: counter.hits, resetTime: counter.resetTime };
  }
  async decrement(key) { await Counter.updateOne({ _id: this.prefix + key, hits: { $gt: 0 } }, { $inc: { hits: -1 } }); }
  async resetKey(key) { await Counter.deleteOne({ _id: this.prefix + key }); }
};
