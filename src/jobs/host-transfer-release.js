const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const { evaluateTransferRelease, applyTransferReleaseState } = require("../utils/transferRelease");

const RELEASE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

const setupHostTransferReleaseJob = () => {
  const run = async () => {
    try {
      const bookings = await Booking.find({
        status: { $in: ["COMPLETED", "AUTO_COMPLETED", "DISPUTE_WON"] },
        payoutEligibleAt: { $exists: true, $ne: null },
      })
        .select("_id status payoutEligibleAt refundedAt disputedAt disputeResolvedAt")
        .sort({ payoutEligibleAt: 1 })
        .limit(100);

      for (const booking of bookings) {
        const payment = await Payment.findOne({
          booking: booking._id,
          chargeModel: "SEPARATE_CHARGE_AND_TRANSFER",
          status: "CONFIRMED",
          transferStatus: { $in: ["NOT_READY", "BLOCKED", "READY", null] },
        }).sort({ createdAt: -1 });

        if (!payment) continue;

        const decision = await evaluateTransferRelease({ booking, payment });
        await applyTransferReleaseState({ booking, payment, decision });
      }
    } catch (err) {
      console.error("Host transfer release job error", err);
    }
  };

  setInterval(run, RELEASE_CHECK_INTERVAL_MS);
  run();
};

module.exports = setupHostTransferReleaseJob;
