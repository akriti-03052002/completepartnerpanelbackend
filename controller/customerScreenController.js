const { Screen } = require("../models/Index");

/* ============================================================
   CUSTOMER — SCREENS (SELF-SERVICE)
   A customer registers the physical screens they run. This
   count is what defaults the screen count on the Subscription
   page (see customerSubscriptionController).
============================================================ */

const listScreens = async (req, res) => {
  const screens = await Screen.find({ customerId: req.customer._id }).sort({ createdAt: -1 });
  return res.json({ success: true, data: screens });
};

const createScreen = async (req, res) => {
  try {
    const { name, location } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Screen name is required." });
    }

    const screen = await Screen.create({
      customerId: req.customer._id,
      name: name.trim(),
      location: location || ""
    });

    return res.status(201).json({ success: true, message: "Screen registered.", data: screen });
  } catch (error) {
    console.error("createScreen error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong registering the screen." });
  }
};

const deleteScreen = async (req, res) => {
  try {
    const screen = await Screen.findOneAndDelete({ _id: req.params.id, customerId: req.customer._id });

    if (!screen) {
      return res.status(404).json({ success: false, message: "Screen not found." });
    }

    return res.json({ success: true, message: "Screen removed." });
  } catch (error) {
    console.error("deleteScreen error:", error);
    return res.status(500).json({ success: false, message: "Something went wrong removing the screen." });
  }
};

module.exports = { listScreens, createScreen, deleteScreen };
