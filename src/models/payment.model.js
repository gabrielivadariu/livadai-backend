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
    stripeTransferId: { type: String },
    stripeTransferReversalId: { type: String },
    amount: { type: Number },
    totalAmount: { type: Number },
    currency: { type: String, default: "ron" },
    livadaiFee: { type: Number },
    hostShare: { type: Number },
    platformFee: { type: Number },
    chargeModel: {
      type: String,
      enum: ["DESTINATION_CHARGE", "SEPARATE_CHARGE_AND_TRANSFER"],
      default: "DESTINATION_CHARGE",
    },
    hostFeeMode: {
      type: String,
      enum: ["STANDARD", "HOST_PAYS_STRIPE"],
      default: "STANDARD",
    },
    transferAmount: { type: Number },
    hostNetAmount: { type: Number },
    estimatedStripeFee: { type: Number },
    transferStatus: {
      type: String,
      enum: ["NOT_READY", "READY", "TRANSFERRED", "BLOCKED", "FAILED", "REVERSED", "NEEDS_MANUAL_REVIEW"],
      default: "NOT_READY",
    },
    transferReadyAt: { type: Date },
    transferredAt: { type: Date },
    transferBlockedReason: { type: String, default: "" },
    transferFailureCode: { type: String, default: "" },
    transferFailureMessage: { type: String, default: "" },
    transferRetryCount: { type: Number, default: 0 },
    lastTransferAttemptAt: { type: Date, default: null },
    nextTransferRetryAt: { type: Date, default: null },
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

paymentSchema.index({ transferStatus: 1, chargeModel: 1, transferReadyAt: 1 });
paymentSchema.index({ transferStatus: 1, nextTransferRetryAt: 1 });
paymentSchema.index({ stripeTransferId: 1 }, { sparse: true });

module.exports = mongoose.model("Payment", paymentSchema);
