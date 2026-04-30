const stripe = require("../config/stripe");
const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const Transaction = require("../models/transaction.model");
const { evaluateTransferRelease, applyTransferReleaseState } = require("../utils/transferRelease");

const RELEASE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const TRANSFER_RETRY_DELAYS_MS = [10 * 60 * 1000, 30 * 60 * 1000, 2 * 60 * 60 * 1000, 24 * 60 * 60 * 1000];

const getRetryAtForFailureCount = (failureCount, now = new Date()) => {
  const delay = TRANSFER_RETRY_DELAYS_MS[Math.max(0, Number(failureCount || 1) - 1)];
  if (!delay) return null;
  return new Date(now.getTime() + delay);
};

const setupHostTransferReleaseJob = () => {
  const run = async () => {
    try {
      const now = new Date();
      const stripeAccountCache = new Map();
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
          transferStatus: { $in: ["NOT_READY", "BLOCKED", "READY", "FAILED", null] },
        }).sort({ createdAt: -1 });

        if (!payment) continue;

        if (String(payment.transferStatus || "") === "FAILED") {
          const currentRetryCount = Math.max(0, Number(payment.transferRetryCount || 0));
          if (currentRetryCount > TRANSFER_RETRY_DELAYS_MS.length) {
            payment.transferStatus = "NEEDS_MANUAL_REVIEW";
            payment.transferBlockedReason = "transfer_retry_limit_reached";
            await payment.save();
            continue;
          }
          const retryAt = payment.nextTransferRetryAt ? new Date(payment.nextTransferRetryAt) : null;
          if (retryAt && !Number.isNaN(retryAt.getTime()) && retryAt > now) {
            continue;
          }
        }

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
          payment.transferFailureCode = "missing_host_stripe_account";
          payment.transferFailureMessage = "Host Stripe account is missing on the payment.";
          payment.nextTransferRetryAt = null;
          await payment.save();
          continue;
        }

        if (!chargeId) {
          payment.transferStatus = "BLOCKED";
          payment.transferBlockedReason = "missing_stripe_charge";
          payment.transferFailureCode = "missing_stripe_charge";
          payment.transferFailureMessage = "Stripe charge reference is missing for the held payment.";
          payment.nextTransferRetryAt = null;
          await payment.save();
          continue;
        }

        if (!transferAmount) {
          payment.transferStatus = "BLOCKED";
          payment.transferBlockedReason = "invalid_transfer_amount";
          payment.transferFailureCode = "invalid_transfer_amount";
          payment.transferFailureMessage = "Transfer amount is invalid or zero for this held payment.";
          payment.nextTransferRetryAt = null;
          await payment.save();
          continue;
        }

        try {
          let stripeAccount = stripeAccountCache.get(destinationAccount);
          if (stripeAccount === undefined) {
            stripeAccount = await stripe.accounts.retrieve(destinationAccount);
            stripeAccountCache.set(destinationAccount, stripeAccount);
          }

          if (!stripeAccount || stripeAccount.deleted) {
            payment.transferStatus = "BLOCKED";
            payment.transferBlockedReason = "host_stripe_account_inaccessible";
            payment.transferFailureCode = "host_stripe_account_inaccessible";
            payment.transferFailureMessage = "Host Stripe account could not be loaded for transfer.";
            payment.nextTransferRetryAt = null;
            await payment.save();
            continue;
          }

          if (stripeAccount.details_submitted !== true) {
            payment.transferStatus = "BLOCKED";
            payment.transferBlockedReason = "host_stripe_details_incomplete";
            payment.transferFailureCode = "host_stripe_details_incomplete";
            payment.transferFailureMessage = "Host Stripe account is missing completed onboarding details.";
            payment.nextTransferRetryAt = null;
            await payment.save();
            continue;
          }

          if (stripeAccount.charges_enabled !== true) {
            payment.transferStatus = "BLOCKED";
            payment.transferBlockedReason = "host_stripe_charges_disabled";
            payment.transferFailureCode = "host_stripe_charges_disabled";
            payment.transferFailureMessage = "Host Stripe account has charges disabled.";
            payment.nextTransferRetryAt = null;
            await payment.save();
            continue;
          }

          if (stripeAccount.payouts_enabled !== true) {
            payment.transferStatus = "BLOCKED";
            payment.transferBlockedReason = "host_stripe_payouts_disabled";
            payment.transferFailureCode = "host_stripe_payouts_disabled";
            payment.transferFailureMessage = "Host Stripe account has payouts disabled.";
            payment.nextTransferRetryAt = null;
            await payment.save();
            continue;
          }

          payment.lastTransferAttemptAt = now;
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
          payment.transferRetryCount = 0;
          payment.nextTransferRetryAt = null;
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
          const nextRetryCount = Math.max(0, Number(payment.transferRetryCount || 0)) + 1;
          const nextRetryAt = getRetryAtForFailureCount(nextRetryCount, now);
          payment.lastTransferAttemptAt = now;
          payment.transferRetryCount = nextRetryCount;
          payment.transferFailureCode = String(err?.code || err?.type || "");
          if (nextRetryAt) {
            payment.transferStatus = "FAILED";
            payment.transferFailureMessage = String(err?.message || "Stripe transfer failed");
            payment.nextTransferRetryAt = nextRetryAt;
          } else {
            payment.transferStatus = "NEEDS_MANUAL_REVIEW";
            payment.transferBlockedReason = "transfer_retry_limit_reached";
            payment.transferFailureMessage = `${String(err?.message || "Stripe transfer failed")} Manual review required after repeated retry failures.`;
            payment.nextTransferRetryAt = null;
          }
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
