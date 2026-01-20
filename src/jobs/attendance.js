const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const { createNotification } = require("../controllers/notifications.controller");
const { sendEmail } = require("../utils/mailer");
const { buildAttendanceReminderEmail } = require("../utils/emailTemplates");
const User = require("../models/user.model");

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
            // If duration is unknown, assume 24h after start as end time.
            endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
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

            if (!bk.attendanceReminderEmailSent) {
              try {
                const hostUser = await User.findById(bk.experience.host).select("email");
                if (hostUser?.email) {
                  const appUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
                  const hostBookingsUrl = `${appUrl.replace(/\/$/, "")}/host/bookings`;
                  const html = buildAttendanceReminderEmail({
                    experience: bk.experience,
                    bookingId: bk._id,
                    ctaUrl: hostBookingsUrl,
                  });
                  await sendEmail({
                    to: hostUser.email,
                    subject: "Confirmă prezența / Confirm attendance – LIVADAI",
                    html,
                    type: "official",
                    userId: hostUser._id,
                  });
                  bk.attendanceReminderEmailSent = true;
                  await bk.save();
                }
              } catch (err) {
                console.error("Attendance reminder email error", err);
              }
            }
          }
        }
      }
    } catch (err) {
      console.error("Attendance job error", err);
    }
  }, 15 * 60 * 1000);
};

module.exports = setupAttendanceJob;
