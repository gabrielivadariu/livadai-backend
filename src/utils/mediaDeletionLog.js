const MediaDeletionLog = require("../models/mediaDeletionLog.model");

const logMediaDeletion = async ({
  scope,
  requestedCount = 0,
  deletedCount = 0,
  entityType = "system",
  entityId = "",
  reason = "",
  details = {},
}) => {
  try {
    await MediaDeletionLog.create({
      scope,
      requestedCount,
      deletedCount,
      entityType,
      entityId: entityId ? String(entityId) : "",
      reason,
      details,
    });
  } catch (err) {
    console.error("Media deletion log error", {
      scope,
      err: err?.message || err,
    });
  }
};

module.exports = { logMediaDeletion };
