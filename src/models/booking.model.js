const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema(
  {
    experience: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Experience",
      required: true,
    },
    explorer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    host: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    quantity: { type: Number, default: 1 },
    amount: { type: Number }, // stored in minor units (cents)
    currency: { type: String, default: "eur" },
    depositAmount: { type: Number, default: 0 }, // minor units
    depositCurrency: { type: String },
    attendanceStatus: { type: String, enum: ["PENDING", "CONFIRMED", "NO_SHOW"], default: "PENDING" },
    date: { type: Date },
    timeSlot: { type: String },
    status: {
      type: String,
      enum: [
        "PENDING",
        "DEPOSIT_PAID",
        "PAID",
        "CANCELLED",
        "REFUNDED",
        "REFUND_FAILED",
        "COMPLETED",
        "AUTO_COMPLETED",
        "NO_SHOW",
        "PENDING_ATTENDANCE",
        "DISPUTED",
        "DISPUTE_WON",
        "DISPUTE_LOST",
      ],
      default: "PENDING",
    },
    attendanceConfirmed: { type: Boolean, default: false },
    reminderSent: { type: Boolean, default: false },
    attendanceReminderEmailSent: { type: Boolean, default: false },
    completedAt: { type: Date },
    payoutEligibleAt: { type: Date },
    chatArchivedAt: { type: Date },
    disputeResolvedAt: { type: Date },
    disputedAt: { type: Date },
    cancelledAt: { type: Date },
    refundedAt: { type: Date },
    disputeReason: {
      type: String,
      enum: ["NO_SHOW", "LOW_QUALITY", "SAFETY", "OTHER", null],
      default: null,
    },
    disputeComment: { type: String, maxlength: 300, default: null },
  },
  { timestamps: true }
);

bookingSchema.index({ chatArchivedAt: 1 });

module.exports = mongoose.model("Booking", bookingSchema);
