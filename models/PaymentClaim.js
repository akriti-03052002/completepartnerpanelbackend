const mongoose = require("mongoose");

// One durable owner for a payment across invoices, prepayments and orders.
module.exports = mongoose.model("PaymentClaim", new mongoose.Schema({
  _id: { type: String },
  target: { type: String, required: true }
}, { timestamps: true }));
