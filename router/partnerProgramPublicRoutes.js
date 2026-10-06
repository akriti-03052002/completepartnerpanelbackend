const express = require("express");
const router = express.Router();

const { listActivePrograms } = require("../controller/partnerProgramPublicController");

router.get("/active", listActivePrograms);

module.exports = router;
