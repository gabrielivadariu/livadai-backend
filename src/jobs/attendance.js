const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");

const FALLBACK_EXPERIENCE_DURATION_MINUTES = 120;

const setupAttendanceJob = () => {
  setInterval(async () => {
    const now = new Date();
    try {
      const bookings = await Booking.find({
        status: { $in: ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE", "CONFIRMED"] },
      }).populate("experience", "endsAt endDate startsAt startDate host title");

      for (const bk of bookings) {
        const expEnd = bk.experience?.endsAt || bk.experience?.endDate;
        const expStart = bk.experience?.startsAt || bk.experience?.startDate;
        const durationMinutes = bk.experience?.durationMinutes;
        const startDate = expStart ? new Date(expStart) : null;
        let endDate = expEnd ? new Date(expEnd) : null;
        if (!endDate && startDate && durationMinutes) {
          if (!Number.isNaN(startDate.getTime())) {
            endDate = new Date(startDate.getTime() + Number(durationMinutes) * 60 * 1000);
          }
        }
        if (!endDate && startDate) {
          if (!Number.isNaN(startDate.getTime())) {
            // If duration is unknown, use a conservative default duration.
            endDate = new Date(startDate.getTime() + FALLBACK_EXPERIENCE_DURATION_MINUTES * 60 * 1000);
          }
        }
        let hardDeadline = null;
        if (startDate && !Number.isNaN(startDate.getTime())) {
          hardDeadline = new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);
        } else if (bk.createdAt) {
          hardDeadline = new Date(new Date(bk.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000);
        }
        if (!endDate || Number.isNaN(endDate.getTime())) {
          endDate = hardDeadline;
        }
        if (!endDate || Number.isNaN(endDate.getTime())) continue;

        if (endDate <= now) {
          bk.status = "AUTO_COMPLETED";
          bk.attendanceStatus = "CONFIRMED";
          bk.attendanceConfirmed = true;
          bk.completedAt = endDate;
          bk.payoutEligibleAt = new Date(endDate.getTime() + 72 * 60 * 60 * 1000);
          await bk.save();
        }
      }
    } catch (err) {
      console.error("Attendance job error", err);
    }
  }, 15 * 60 * 1000);
};

module.exports = setupAttendanceJob;
