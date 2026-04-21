const stripe = require("../config/stripe");
const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const Transaction = require("../models/transaction.model");
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

        if (!decision.eligible) continue;
        if (payment.transferStatus !== "READY") continue;

        const destinationAccount = String(payment.stripeAccountId || "").trim();
        const chargeId = String(payment.stripeChargeId || "").trim();
        const transferAmount = Math.max(0, Number(payment.transferAmount || payment.hostNetAmount || 0));

        if (!destinationAccount) {
          payment.transferStatus = "BLOCKED";
          payment.transferBlockedReason = "missing_host_stripe_account";
          await payment.save();
          continue;
        }

        if (!chargeId) {
          payment.transferStatus = "BLOCKED";
          payment.transferBlockedReason = "missing_stripe_charge";
          await payment.save();
          continue;
        }

        if (!transferAmount) {
          payment.transferStatus = "BLOCKED";
          payment.transferBlockedReason = "invalid_transfer_amount";
          await payment.save();
          continue;
        }

        try {
          const transfer = await stripe.transfers.create(
            {
              amount: transferAmount,
              currency: payment.currency || "ron",
              destination: destinationAccount,
              source_transaction: chargeId,
              metadata: {
                bookingId: String(booking._id),
                paymentId: String(payment._id),
                hostId: String(payment.host || booking.host || ""),
                releaseRule: "completed_plus_72h",
              },
            },
            { idempotencyKey: `host_transfer_release_${payment._id}` }
          );

          payment.transferStatus = "TRANSFERRED";
          payment.stripeTransferId = transfer.id;
          payment.transferredAt = new Date();
          payment.transferBlockedReason = "";
          payment.transferFailureCode = "";
          payment.transferFailureMessage = "";
          await payment.save();

          if (payment.host) {
            await Transaction.findOneAndUpdate(
              { stripeTransferId: transfer.id },
              {
                user: payment.host,
                booking: booking._id,
                stripeAccountId: destinationAccount,
                amount: transferAmount,
                currency: payment.currency || "ron",
                type: "payout",
                stripePaymentIntentId: payment.stripePaymentIntentId,
                stripeChargeId: chargeId,
                stripeTransferId: transfer.id,
                platformFee: payment.platformFee || payment.livadaiFee || 0,
                status: "TRANSFERRED",
              },
              { upsert: true, new: true }
            );
          }
        } catch (err) {
          payment.transferStatus = "FAILED";
          payment.transferFailureCode = String(err?.code || err?.type || "");
          payment.transferFailureMessage = String(err?.message || "Stripe transfer failed");
          await payment.save();
          console.error("Host transfer release error", {
            paymentId: String(payment._id),
            bookingId: String(booking._id),
            message: err?.message || err,
          });
        }
      }
    } catch (err) {
      console.error("Host transfer release job error", err);
    }
  };

  setInterval(run, RELEASE_CHECK_INTERVAL_MS);
  run();
};

module.exports = setupHostTransferReleaseJob;
