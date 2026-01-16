const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");

// Runs periodically to hide/delete stale experiences.
// Rules:
// - If experience has ended AND has no bookings -> hard delete.
// - If experience has ended AND has bookings -> mark inactive/cancelled.
// - If experience is sold out / no remaining spots -> mark inactive (keep record for bookings).
const setupCleanupJob = () => {
  const run = async () => {
    const now = new Date();
    try {
      const ended = await Experience.find({
        isActive: true,
        endsAt: { $lte: now },
      });

      for (const exp of ended) {
        const bookingsCount = await Booking.countDocuments({ experience: exp._id });
        if (bookingsCount === 0) {
          await Experience.deleteOne({ _id: exp._id });
          console.log("Cleanup: deleted expired experience with no bookings", { id: exp._id.toString() });
        } else {
          exp.isActive = false;
          exp.status = "cancelled";
          exp.soldOut = true;
          exp.remainingSpots = 0;
          await exp.save();
          console.log("Cleanup: archived expired experience with bookings", { id: exp._id.toString(), bookingsCount });
        }
      }

      const soldOut = await Experience.updateMany(
        {
          $or: [{ soldOut: true }, { remainingSpots: { $lte: 0 } }],
        },
        {
          $set: { soldOut: true, remainingSpots: 0 },
        }
      );
      if (soldOut.modifiedCount) {
        console.log("Cleanup: marked sold-out experiences", { count: soldOut.modifiedCount });
      }
    } catch (err) {
      console.error("Cleanup job error", err);
    }
  };

  // Run every 15 minutes
  setInterval(run, 15 * 60 * 1000);
  // Run once on startup
  run();
};

module.exports = setupCleanupJob;
