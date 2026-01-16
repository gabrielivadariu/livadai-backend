const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    stripePaymentIntentId: { type: String },
    stripeSessionId: { type: String },
    amount: { type: Number },
    livadaiFee: { type: Number },
    hostShare: { type: Number },
    paymentType: { type: String, enum: ["PAID_BOOKING", "DEPOSIT"], default: "PAID_BOOKING" },
    status: {
      type: String,
      enum: ["INITIATED", "CONFIRMED", "FAILED", "REFUNDED"],
      default: "INITIATED",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
