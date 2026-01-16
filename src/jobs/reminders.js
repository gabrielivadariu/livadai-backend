const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");
const { createNotification } = require("../controllers/notifications.controller");

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
        // Host reminder (only once)
        if (!exp.reminderHostSent) {
          await createNotification({
            user: exp.host,
            type: "EVENT_REMINDER_HOST",
            title: "Upcoming experience",
            message: `"${exp.title}" starts in 24 hours.`,
            data: { activityId: exp._id, activityTitle: exp.title },
          });
          exp.reminderHostSent = true;
          await exp.save();
        }

        // Explorer reminders
        const bookings = await Booking.find({ experience: exp._id, status: "PAID", reminderSent: { $ne: true } }).select(
          "explorer reminderSent"
        );
        for (const bk of bookings) {
          await createNotification({
            user: bk.explorer,
            type: "EVENT_REMINDER_EXPLORER",
            title: "Don’t forget your experience",
            message: `"${exp.title}" starts in 24 hours.`,
            data: { activityId: exp._id, bookingId: bk._id, activityTitle: exp.title },
          });
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
