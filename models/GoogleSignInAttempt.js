const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  browserHash: { type: String, required: true, unique: true },
  stateHash: { type: String, required: true, unique: true },
  endpoint: String,
  mode: String,
  returnTo: String,
  redirectUri: String,
  nonce: String,
  verifier: String,
  status: { type: String, default: "started" },
  credential: String,
  message: String,
  expiresAt: { type: Date, required: true, expires: 0 }
});

module.exports = mongoose.model("GoogleSignInAttempt", schema);
