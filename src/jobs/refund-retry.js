const stripe = require("../config/stripe");
const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const { sendEmail } = require("../utils/mailer");
const { createNotification } = require("../controllers/notifications.controller");
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

const getFirstName = (user, language) => {
  const name = user?.displayName || user?.name || "";
  if (!name) return language === "ro" ? "acolo" : "there";
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
        const amountMinor = payment?.amount || bk.amount || bk.depositAmount || 0;
        const amount = (Number(amountMinor) / 100).toFixed(2);
        const currency = (payment?.currency || bk.currency || bk.depositCurrency || "RON").toUpperCase();
        const language = resolveLanguage(explorer);
        const firstName = getFirstName(explorer, language);
        const experienceTitle = bk.experience?.title || "LIVADAI";
        const emailPayload = buildRefundCompletedEmail({
          language,
          firstName,
          experienceTitle,
          amount,
          currency,
        });
        try {
          if (explorer?.email) {
            await sendEmail({
              to: explorer.email,
              subject: emailPayload.subject,
              html: emailPayload.html,
              type: "booking_cancelled",
              userId: explorer._id,
            });
          }

          const notifTitle = language === "ro" ? "Refund confirmat" : "Refund confirmed";
          const notifMessage =
            language === "ro"
              ? `Refund confirmat pentru experiența ${experienceTitle ? `„${experienceTitle}”` : "ta"} – ${amount} ${currency}`
              : `Refund confirmed for the experience ${experienceTitle ? `“${experienceTitle}”` : "you booked"} – ${amount} ${currency}`;
          await createNotification({
            user: explorer?._id,
            type: "BOOKING_CANCELLED",
            title: notifTitle,
            message: notifMessage,
            data: { bookingId: bk._id, activityId: bk.experience?._id, activityTitle: experienceTitle },
            push: true,
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
