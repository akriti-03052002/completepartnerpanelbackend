/**
 * One-off script to create the first super_admin.
 * Run: node seed/seedAdmin.js "Admin Name" admin@spotx.com yourpassword
 */
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const { User } = require("../models/Index");

const run = async () => {
  const [name, email, password] = process.argv.slice(2);

  if (!name || !email || !password) {
    console.error('Usage: node seed/seedAdmin.js "Admin Name" admin@spotx.com yourpassword');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const existing = await User.findOne({ email: email.toLowerCase().trim() });

  if (existing) {
    console.log(`A user with email ${email} already exists (role: ${existing.role}).`);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await User.create({
    name,
    email: email.toLowerCase().trim(),
    passwordHash,
    role: "super_admin",
    status: "active"
  });

  console.log(`Super admin created: ${admin.email}`);
  process.exit(0);
};

run().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
