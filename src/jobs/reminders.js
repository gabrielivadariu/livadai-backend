const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");
const User = require("../models/user.model");
const { createNotification } = require("../controllers/notifications.controller");
const { sendEmail } = require("../utils/mailer");
const { buildBookingReminderEmail, formatExperienceDate } = require("../utils/emailTemplates");

// Runs every 15 minutes to send reminder notifications 24h before start
const setupReminderJob = () => {
  setInterval(async () => {
    const now = new Date();
    const startWindow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const endWindow = new Date(startWindow.getTime() + 15 * 60 * 1000);
    try {
      const exps = await Experience.find({
        startsAt: { $gte: startWindow, $lt: endWindow },
        status: "published",
      }).select("_id title host startsAt reminderHostSent");

      for (const exp of exps) {
        const appUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
        const explorerBookingsUrl = `${appUrl.replace(/\/$/, "")}/my-activities`;
        const hostBookingsUrl = `${appUrl.replace(/\/$/, "")}/profile`;
        // Host reminder (only once)
        if (!exp.reminderHostSent) {
          await createNotification({
            user: exp.host,
            type: "EVENT_REMINDER_HOST",
            title: "Upcoming experience",
            message: `"${exp.title}" starts in 24 hours.`,
            data: { activityId: exp._id, activityTitle: exp.title },
          });
          try {
            const hostUser = await User.findById(exp.host).select("email name displayName");
            if (hostUser?.email) {
              const dateLabel = formatExperienceDate(exp);
              const html = buildBookingReminderEmail({
                experience: exp,
                ctaUrl: hostBookingsUrl,
              });
              await sendEmail({
                to: hostUser.email,
                subject: `Reminder: ${exp?.title || "LIVADAI"} – ${dateLabel}`,
                html,
                type: "booking_reminder",
                userId: hostUser._id,
              });
            }
          } catch (err) {
            console.error("Host reminder email error", err);
          }
          exp.reminderHostSent = true;
          await exp.save();
        }

        // Explorer reminders
        const bookings = await Booking.find({ experience: exp._id, status: "PAID", reminderSent: { $ne: true } })
          .select("explorer reminderSent")
          .populate("explorer", "email name displayName");
        for (const bk of bookings) {
          await createNotification({
            user: bk.explorer,
            type: "EVENT_REMINDER_EXPLORER",
            title: "Don’t forget your experience",
            message: `"${exp.title}" starts in 24 hours.`,
            data: { activityId: exp._id, bookingId: bk._id, activityTitle: exp.title },
          });
          try {
            const explorer = bk.explorer;
            if (explorer?.email) {
              const dateLabel = formatExperienceDate(exp);
              const html = buildBookingReminderEmail({
                experience: exp,
                bookingId: bk._id,
                ctaUrl: explorerBookingsUrl,
              });
              await sendEmail({
                to: explorer.email,
                subject: `Reminder: ${exp?.title || "LIVADAI"} – ${dateLabel} (#${bk._id})`,
                html,
                type: "booking_reminder",
                userId: explorer._id,
              });
            }
          } catch (err) {
            console.error("Explorer reminder email error", err);
          }
          bk.reminderSent = true;
          await bk.save();
        }
      }
    } catch (err) {
      console.error("Reminder job error", err);
    }
  }, 15 * 60 * 1000);
};

module.exports = setupReminderJob;
