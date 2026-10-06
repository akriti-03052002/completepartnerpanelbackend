const express = require("express");
const router = express.Router();

const customerPortalAuthMiddleware = require("../middleware/customerPortalAuthMiddleware");
const { getMyPortalInfo, getMyScreens, registerMyScreen, updateMyScreen } = require("../controller/publicResellerCustomerController");

router.get("/me", customerPortalAuthMiddleware, getMyPortalInfo);
router.get("/screens", customerPortalAuthMiddleware, getMyScreens);
router.post("/screens", customerPortalAuthMiddleware, registerMyScreen);
router.patch("/screens/:id", customerPortalAuthMiddleware, updateMyScreen);

module.exports = router;
