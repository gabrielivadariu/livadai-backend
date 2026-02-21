const stripe = require("../config/stripe");
const Payment = require("../models/payment.model");
const { handlePaymentSuccess } = require("../controllers/payment.controller");

const stripeKey = process.env.STRIPE_SECRET_KEY || "";
const isLiveStripeKey = stripeKey.startsWith("sk_live_");

const setupReconcilePaymentsJob = () => {
  const run = async () => {
    try {
      const pendingPayments = await Payment.find({
        status: "INITIATED",
        stripeSessionId: { $exists: true, $ne: null },
      })
        .sort({ createdAt: -1 })
        .limit(50);

      for (const payment of pendingPayments) {
        try {
          const sessionId = payment.stripeSessionId || "";
          if (isLiveStripeKey && sessionId.startsWith("cs_test_")) {
            // Prevent infinite retries for old test sessions left in production DB.
            payment.status = "FAILED";
            await payment.save();
            console.warn("Reconcile skipped test session in live mode", {
              paymentId: payment._id?.toString(),
              sessionId,
            });
            continue;
          }

          const session = await stripe.checkout.sessions.retrieve(sessionId);
          if (session?.payment_status === "paid") {
            await handlePaymentSuccess({
              bookingId: payment.booking?.toString(),
              paymentIntentId: session.payment_intent,
              sessionId: session.id,
              isDeposit: session.metadata?.isDeposit === "true",
            });
          }
        } catch (err) {
          const message = err?.message || "";
          const isMissingSession = err?.code === "resource_missing" || message.includes("No such checkout.session");
          if (isMissingSession) {
            payment.status = "FAILED";
            await payment.save();
            console.warn("Reconcile payment session missing; marked FAILED", {
              paymentId: payment._id?.toString(),
              sessionId: payment.stripeSessionId,
              message,
            });
          } else {
            console.error("Reconcile payment session error", {
              paymentId: payment._id?.toString(),
              sessionId: payment.stripeSessionId,
              message: err?.message || err,
            });
          }
        }
      }
    } catch (err) {
      console.error("Reconcile payments job error", err);
    }
  };

  // Run every 10 minutes
  setInterval(run, 10 * 60 * 1000);
  // Run once on startup
  run();
};

module.exports = setupReconcilePaymentsJob;
