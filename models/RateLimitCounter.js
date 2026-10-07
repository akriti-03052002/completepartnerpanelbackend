const mongoose = require("mongoose");
const schema = new mongoose.Schema({ _id: String, hits: Number, resetTime: Date }, { versionKey: false });
schema.index({ resetTime: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model("RateLimitCounter", schema);
