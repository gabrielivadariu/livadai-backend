const stripe = require("../config/stripe");
const Payment = require("../models/payment.model");
const { handlePaymentSuccess } = require("../controllers/payment.controller");

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
          const session = await stripe.checkout.sessions.retrieve(payment.stripeSessionId);
          if (session?.payment_status === "paid") {
            await handlePaymentSuccess({
              bookingId: payment.booking?.toString(),
              paymentIntentId: session.payment_intent,
              sessionId: session.id,
              isDeposit: session.metadata?.isDeposit === "true",
            });
          }
        } catch (err) {
          console.error("Reconcile payment session error", {
            paymentId: payment._id?.toString(),
            sessionId: payment.stripeSessionId,
            message: err?.message || err,
          });
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
