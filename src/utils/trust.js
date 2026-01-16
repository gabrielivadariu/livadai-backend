const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const Report = require("../models/report.model");

// Determine if a report counts as valid (non-ignored handled report)
const countValidReportsAgainstUser = async (userId) => {
  return Report.countDocuments({
    targetUserId: userId,
    status: "HANDLED",
    actionTaken: { $ne: "IGNORE" },
  });
};

const countCompletedBookings = async (userId) => {
  return Booking.countDocuments({ explorer: userId, status: "COMPLETED" });
};

const recalcTrustedParticipant = async (userId) => {
  if (!userId) return false;
  const user = await User.findById(userId);
  if (!user) return false;

  const accountAgeDays = Math.floor((Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24));
  const completed = await countCompletedBookings(userId);
  const reports = await countValidReportsAgainstUser(userId);
  const cancels = user.clientFaultCancelsCount || 0;

  const ok =
    completed >= 3 &&
    reports === 0 &&
    cancels === 0 &&
    accountAgeDays >= 30 &&
    !user.isBanned &&
    !user.isBlocked;

  if (user.isTrustedParticipant !== ok) {
    user.isTrustedParticipant = ok;
    await user.save();
  }
  return ok;
};

module.exports = { recalcTrustedParticipant };
