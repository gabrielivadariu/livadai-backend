const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true }, // host
    booking: { type: mongoose.Schema.Types.ObjectId, ref: "Booking" },
    stripeAccountId: { type: String },
    amount: { type: Number, required: true }, // minor units
    currency: { type: String, default: "ron" },
    type: { type: String, enum: ["payment", "payout"], default: "payment" },
    stripePaymentIntentId: { type: String, unique: true, sparse: true },
    stripeChargeId: { type: String },
    platformFee: { type: Number },
    status: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Transaction", transactionSchema);
