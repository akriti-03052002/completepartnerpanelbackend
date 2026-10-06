const express = require("express");
const router = express.Router();

const { listCustomers, getCustomer, createCustomer } = require("../controller/partnerCustomerController");
const requirePermission = require("../middleware/requirePermission");

router.get("/", requirePermission("customers:view"), listCustomers);
router.post("/", requirePermission("customers:manage"), createCustomer);
router.get("/:id", requirePermission("customers:view"), getCustomer);

module.exports = router;
