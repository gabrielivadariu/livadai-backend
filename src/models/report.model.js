const mongoose = require("mongoose");

const reportSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["CONTENT", "BOOKING_DISPUTE", "USER", "STRIPE_DISPUTE"], required: true },
    experience: { type: mongoose.Schema.Types.ObjectId, ref: "Experience" },
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reporter: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    targetType: { type: String, enum: ["EXPERIENCE", "USER", null], default: null },
    targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reason: { type: String },
    comment: { type: String, maxlength: 300 },
    affectsPayout: { type: Boolean, default: false },
    status: { type: String, enum: ["OPEN", "HANDLED", "IGNORED"], default: "OPEN" },
    deadlineAt: { type: Date },
    handledAt: { type: Date },
    handledBy: { type: String },
    actionTaken: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Report", reportSchema);
