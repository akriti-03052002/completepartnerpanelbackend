const express = require("express");
const router = express.Router();

const { listTeam, inviteTeamMember, updateTeamMember } = require("../controller/partnerUserController");
const requirePermission = require("../middleware/requirePermission");

router.use(require("../middleware/requirePartnerType")("affiliate", "vendor", "reseller"));

router.get("/", requirePermission("team:view"), listTeam);
router.post("/", requirePermission("team:manage"), inviteTeamMember);
router.patch("/:id", requirePermission("team:manage"), updateTeamMember);

module.exports = router;
