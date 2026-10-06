const { PartnerActivity } = require("../models/Index");

/**
 * Thin wrapper so every controller logs activity the same way instead
 * of repeating the PartnerActivity.create({...}) block. Never throws —
 * an audit-log failure should not fail the request it's logging.
 */
const logActivity = async ({
  partnerId,
  performedByType,
  performedByUserId,
  activityType,
  entityType,
  entityId,
  description = "",
  metadata,
  req
}) => {
  try {
    await PartnerActivity.create({
      partnerId,
      performedBy: {
        type: performedByType,
        userId: performedByUserId
      },
      activityType,
      entity: entityType
        ? { type: entityType, entityId }
        : undefined,
      description,
      metadata,
      ipAddress: req?.ip,
      userAgent: req?.get ? req.get("user-agent") : undefined
    });
  } catch (error) {
    console.error("Activity log failed:", error.message);
  }
};

module.exports = logActivity;
