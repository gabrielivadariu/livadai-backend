const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      required: true,
    },
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    explorer: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    stripeAccountId: { type: String },
    stripePaymentIntentId: { type: String },
    stripeSessionId: { type: String },
    stripeChargeId: { type: String },
    amount: { type: Number },
    totalAmount: { type: Number },
    currency: { type: String, default: "ron" },
    livadaiFee: { type: Number },
    hostShare: { type: Number },
    platformFee: { type: Number },
    paymentType: { type: String, enum: ["PAID_BOOKING", "DEPOSIT", "SERVICE_FEE"], default: "PAID_BOOKING" },
    analytics: {
      anonymousId: { type: String, default: "" },
      sessionId: { type: String, default: "" },
      source: { type: String, default: "" },
      medium: { type: String, default: "" },
      campaign: { type: String, default: "" },
      channelGroup: { type: String, default: "" },
      landingPage: { type: String, default: "" },
      page: { type: String, default: "" },
      path: { type: String, default: "" },
      platform: { type: String, default: "" },
    },
    status: {
      type: String,
      enum: ["INITIATED", "CONFIRMED", "FAILED", "REFUNDED", "DISPUTED", "DISPUTE_WON", "DISPUTE_LOST"],
      default: "INITIATED",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);
