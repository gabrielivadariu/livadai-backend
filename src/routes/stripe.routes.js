const { Router } = require("express");
const express = require("express");
const { authenticate, authorize } = require("../middleware/auth.middleware");
const {
  createHostAccount,
  createOnboardingLink,
  hostDashboardLink,
  createCheckout,
  walletBalance,
  walletTransactions,
  debugHostStatus,
} = require("../controllers/stripe.controller");
const stripe = require("../config/stripe");
const User = require("../models/user.model");
const Transaction = require("../models/transaction.model");
const { handlePaymentSuccess } = require("../controllers/payment.controller");
const WebhookEvent = require("../models/webhookEvent.model");

const router = Router();
const webhookRouter = Router();

// Host onboarding
router.post("/create-host-account", authenticate, authorize(["HOST"]), createHostAccount);
router.post("/create-onboarding-link", authenticate, authorize(["HOST"]), createOnboardingLink);
// Host dashboard login link
router.get("/host-dashboard", authenticate, authorize(["HOST"]), hostDashboardLink);
// Client checkout -> payment intent
router.post("/checkout", authenticate, authorize(["EXPLORER", "HOST", "BOTH"]), createCheckout);
// Host wallet balance
router.get("/wallet/balance", authenticate, authorize(["HOST"]), walletBalance);
// Host wallet transactions
router.get("/wallet/transactions", authenticate, authorize(["HOST"]), walletTransactions);
// Debug host status
router.get("/debug/host-status", authenticate, authorize(["HOST"]), debugHostStatus);

// Stripe webhook (raw body)
webhookRouter.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      console.error("Stripe webhook error: STRIPE_WEBHOOK_SECRET is missing");
      return res.status(500).send("Webhook secret not configured");
    }
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      const allowed = new Set(["checkout.session.completed", "payment_intent.succeeded", "account.updated"]);
      if (!allowed.has(event.type)) {
        console.log("Ignored Stripe event:", event.type);
        return res.status(200).json({ received: true, ignored: true });
      }

      try {
        await WebhookEvent.create({
          eventId: event.id,
          type: event.type,
          payload: event.data?.object,
        });
      } catch (err) {
        if (err?.code === 11000) {
          console.log("Stripe webhook duplicate event ignored", { eventId: event.id, type: event.type });
          return res.json({ received: true, duplicate: true });
        }
        throw err;
      }

      switch (event.type) {
        case "account.updated": {
          const account = event.data.object;
          const { id, charges_enabled, payouts_enabled, details_submitted } = account || {};
          const updated = await User.findOneAndUpdate(
            { stripeAccountId: id },
            {
              isStripeChargesEnabled: !!charges_enabled,
              isStripePayoutsEnabled: !!payouts_enabled,
              isStripeDetailsSubmitted: !!details_submitted,
            },
            { new: true }
          );
          console.log("Stripe webhook account.updated -> user updated", {
            accountId: id,
            charges_enabled,
            payouts_enabled,
            details_submitted,
            userFound: !!updated,
          });
          break;
        }
        case "checkout.session.completed": {
          const session = event.data.object;
          const paymentIntentId = session.payment_intent;
          const sessionId = session.id;
          const bookingId = session.metadata?.bookingId;
          const isDeposit = session.metadata?.isDeposit === "true";
          if (bookingId) {
            await handlePaymentSuccess({ bookingId, paymentIntentId, sessionId, isDeposit });
          }
          break;
        }
        case "payment_intent.succeeded": {
          const pi = event.data.object;
          const hostId = pi.metadata?.hostId;
          if (hostId) {
            await Transaction.create({
              user: hostId,
              amount: pi.amount_received || pi.amount || 0,
              currency: pi.currency || "ron",
              type: "payment",
              stripePaymentIntentId: pi.id,
            });
          }
          break;
        }
        default:
          console.log("Unhandled Stripe event:", event.type);
          return res.status(200).json({ received: true, ignored: true });
      }
    } catch (err) {
      console.error("Stripe webhook processing error", err);
      return res.status(500).send("Webhook handler failed");
    }

    res.json({ received: true });
  }
);

module.exports = { router, webhookRouter };
