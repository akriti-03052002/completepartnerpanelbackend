const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User } = require("../models/Index");

/* ============================================================
   ADMIN AUTH
   No public registration — first super_admin is created via
   backend/seed/seedAdmin.js.
============================================================ */

const generateAdminToken = (user) =>
  jwt.sign({ adminId: user._id, role: user.role }, process.env.ADMIN_JWT_SECRET, { expiresIn: "12h" });

const loginAdmin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select("+passwordHash");

    if (!user) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    if (user.status === "blocked") {
      return res.status(403).json({ success: false, message: "Your admin access has been blocked." });
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const token = generateAdminToken(user);

    return res.json({
      success: true,
      message: "Login successful.",
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role }
    });
  } catch (error) {
    console.error("Admin login error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong during login." });
  }
};

module.exports = { loginAdmin };
