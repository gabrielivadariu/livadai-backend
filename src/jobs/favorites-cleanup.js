const Experience = require("../models/experience.model");
const User = require("../models/user.model");

const setupFavoritesCleanupJob = () => {
  const run = async () => {
    const now = new Date();
    try {
      const expired = await Experience.find({
        $or: [
          { startsAt: { $lte: now } },
          { startDate: { $lte: now } },
        ],
      }).select("_id");
      if (!expired.length) return;

      const expiredIds = expired.map((exp) => exp._id);
      const result = await User.updateMany(
        { favorites: { $in: expiredIds } },
        { $pull: { favorites: { $in: expiredIds } } }
      );

      if (result.modifiedCount) {
        console.log("Favorites cleanup: removed expired favorites", {
          users: result.modifiedCount,
          experiences: expiredIds.length,
        });
      }
    } catch (err) {
      console.error("Favorites cleanup job error", err);
    }
  };

  // Run daily
  setInterval(run, 24 * 60 * 60 * 1000);
  // Run once on startup
  run();
};

module.exports = setupFavoritesCleanupJob;
