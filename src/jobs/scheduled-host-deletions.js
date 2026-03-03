const User = require("../models/user.model");

const DAY_MS = 24 * 60 * 60 * 1000;

const processScheduledHostDeletions = async () => {
  const now = new Date();
  const dueHosts = await User.find({
    role: { $in: ["HOST", "BOTH"] },
    accountDeletionStatus: "SCHEDULED",
    accountDeletionScheduledAt: { $lte: now },
  }).select("_id email role accountDeletionRequestedAt accountDeletionScheduledAt");

  if (!dueHosts.length) return { due: 0, deleted: 0 };

  const ids = dueHosts.map((row) => row._id);
  const result = await User.deleteMany({ _id: { $in: ids } });

  return {
    due: dueHosts.length,
    deleted: Number(result.deletedCount || 0),
  };
};

const setupScheduledHostDeletionsJob = () => {
  const configured = Number(process.env.HOST_DELETION_JOB_INTERVAL_MS || DAY_MS);
  const intervalMs = Number.isFinite(configured) && configured > 0 ? configured : DAY_MS;

  const run = async () => {
    try {
      const outcome = await processScheduledHostDeletions();
      if (outcome.deleted > 0) {
        console.log("Scheduled host deletions job processed", {
          due: outcome.due,
          deleted: outcome.deleted,
          at: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error("Scheduled host deletions job error", err);
    }
  };

  setInterval(run, intervalMs);
  void run();
};

module.exports = setupScheduledHostDeletionsJob;
module.exports.processScheduledHostDeletions = processScheduledHostDeletions;
