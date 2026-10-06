const mongoose = require("mongoose");
module.exports = mongoose.model("JobLease", new mongoose.Schema({
  _id: String, owner: String, expiresAt: Date
}));
