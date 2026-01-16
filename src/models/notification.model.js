const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    type: {
      type: String,
      enum: [
        "BOOKING_CONFIRMED",
        "BOOKING_RECEIVED",
        "BOOKING_CANCELLED",
        "EVENT_REMINDER_HOST",
        "EVENT_REMINDER_EXPLORER",
        "MESSAGE_NEW",
      ],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", notificationSchema);
