const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const { createNotification } = require("../controllers/notifications.controller");

const setupAttendanceJob = () => {
  setInterval(async () => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    try {
      const bookings = await Booking.find({
        status: { $in: ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE"] },
        attendanceConfirmed: false,
      }).populate("experience", "endsAt endDate startsAt startDate host title");

      for (const bk of bookings) {
        const expEnd = bk.experience?.endsAt || bk.experience?.endDate;
        if (!expEnd) continue;
        const endDate = new Date(expEnd);
        if (Number.isNaN(endDate.getTime())) continue;
        if (endDate < cutoff) {
          // auto-complete
          bk.status = "AUTO_COMPLETED";
          bk.attendanceStatus = "CONFIRMED";
          bk.attendanceConfirmed = true;
          bk.completedAt = endDate;
          bk.payoutEligibleAt = new Date(endDate.getTime() + 72 * 60 * 60 * 1000);
          await bk.save();
          if (bk.experience?.host) {
            await createNotification({
              user: bk.experience.host,
              type: "ATTENDANCE_REQUIRED",
              title: "Booking auto-completed",
              message: `Booking for "${bk.experience.title}" was auto-completed after the confirmation window.`,
              data: { bookingId: bk._id, activityId: bk.experience._id, activityTitle: bk.experience.title },
            });
          }
        } else if (endDate < now) {
          // still within 48h, remind host
          if (bk.experience?.host) {
            await createNotification({
              user: bk.experience.host,
              type: "ATTENDANCE_REQUIRED",
              title: "Attendance confirmation pending",
              message: `Please confirm attendance for "${bk.experience.title}" within 48h after it ends.`,
              data: { bookingId: bk._id, activityId: bk.experience._id, activityTitle: bk.experience.title },
            });
          }
        }
      }
    } catch (err) {
      console.error("Attendance job error", err);
    }
  }, 15 * 60 * 1000);
};

module.exports = setupAttendanceJob;
