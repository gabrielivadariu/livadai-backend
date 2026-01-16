const mongoose = require("mongoose");

const payoutSchema = new mongoose.Schema(
  {
    host: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    amount: { type: Number },
    stripePayoutId: { type: String },
    status: { type: String, enum: ["PENDING", "SENT", "FAILED"], default: "PENDING" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payout", payoutSchema);
