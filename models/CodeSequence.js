const mongoose = require("mongoose");

module.exports = mongoose.model("CodeSequence", new mongoose.Schema({
  _id: String,
  value: Number
}, { versionKey: false }));
