const stripe = require("../config/stripe");
const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const { sendEmail } = require("../utils/mailer");
const { buildRefundCompletedEmail } = require("../utils/emailTemplates");

const RESEND_AFTER_MS = 6 * 60 * 60 * 1000;

const resolveLanguage = (user) => {
  const langs = Array.isArray(user?.languages) ? user.languages : [];
  const normalized = langs.map((l) => String(l).toLowerCase());
  if (normalized.some((l) => l.startsWith("ro") || l.includes("romanian") || l.includes("română"))) {
    return "ro";
  }
  return "en";
};

const getFirstName = (user) => {
  const name = user?.displayName || user?.name || "";
  if (!name) return "there";
  return name.split(" ")[0] || name;
};

const setupRefundRetryJob = () => {
  const run = async () => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - RESEND_AFTER_MS);
    try {
      const bookings = await Booking.find({
        status: "REFUND_FAILED",
        refundAttempts: { $lt: 5 },
        $or: [
          { lastRefundAttemptAt: { $exists: false } },
          { lastRefundAttemptAt: null },
          { lastRefundAttemptAt: { $lte: cutoff } },
        ],
      })
        .populate("experience", "title")
        .populate("explorer", "email name displayName languages");

      for (const bk of bookings) {
        bk.refundAttempts = (bk.refundAttempts || 0) + 1;
        bk.lastRefundAttemptAt = now;
        await bk.save();

        const payment = await Payment.findOne({ booking: bk._id })
          .sort({ createdAt: -1 })
          .select("stripePaymentIntentId stripeChargeId status currency amount");

        if (payment?.status === "REFUNDED") {
          bk.status = "REFUNDED";
          bk.refundedAt = bk.refundedAt || now;
          await bk.save();
        } else {
          const paymentIntentId = payment?.stripePaymentIntentId;
          const chargeId = payment?.stripeChargeId;
          if (!paymentIntentId && !chargeId) {
            continue;
          }
          try {
            await stripe.refunds.create(
              paymentIntentId ? { payment_intent: paymentIntentId } : { charge: chargeId },
              { idempotencyKey: `refund_retry_${bk._id}_${bk.refundAttempts}` }
            );
            if (payment) {
              payment.status = "REFUNDED";
              await payment.save();
            }
            bk.status = "REFUNDED";
            bk.refundedAt = now;
            await bk.save();
          } catch (err) {
            console.error("Refund retry failed", err?.message || err);
            continue;
          }
        }

        if (bk.refundSuccessEmailSent) continue;
        const explorer = bk.explorer;
        if (!explorer?.email) continue;
        const amountMinor = payment?.amount || bk.amount || bk.depositAmount || 0;
        const amount = (Number(amountMinor) / 100).toFixed(2);
        const currency = (payment?.currency || bk.currency || bk.depositCurrency || "RON").toUpperCase();
        const language = resolveLanguage(explorer);
        const firstName = getFirstName(explorer);
        const experienceTitle = bk.experience?.title || "LIVADAI";
        const emailPayload = buildRefundCompletedEmail({
          language,
          firstName,
          experienceTitle,
          amount,
          currency,
        });
        try {
          await sendEmail({
            to: explorer.email,
            subject: emailPayload.subject,
            html: emailPayload.html,
            type: "booking_cancelled",
            userId: explorer._id,
          });
          bk.refundSuccessEmailSent = true;
          await bk.save();
        } catch (err) {
          console.error("Refund completed email error", err);
        }
      }
    } catch (err) {
      console.error("Refund retry job error", err);
    }
  };

  setInterval(run, RESEND_AFTER_MS);
  run();
};

module.exports = setupRefundRetryJob;
