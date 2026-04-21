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
const Payment = require("../models/payment.model");
const Booking = require("../models/booking.model");
const Report = require("../models/report.model");
const { handlePaymentSuccess } = require("../controllers/payment.controller");
const WebhookEvent = require("../models/webhookEvent.model");
const { syncHostComplianceSnapshot } = require("../utils/hostCompliance");

const router = Router();
const webhookRouter = Router();

// Host onboarding
router.post("/create-host-account", authenticate, authorize(["HOST", "BOTH"]), createHostAccount);
router.post("/create-onboarding-link", authenticate, authorize(["HOST", "BOTH"]), createOnboardingLink);
// Host dashboard login link
router.get("/host-dashboard", authenticate, authorize(["HOST", "BOTH"]), hostDashboardLink);
// Client checkout -> payment intent
router.post("/checkout", authenticate, authorize(["EXPLORER", "HOST", "BOTH"]), createCheckout);
// Host wallet balance
router.get("/wallet/balance", authenticate, authorize(["HOST", "BOTH"]), walletBalance);
// Host wallet transactions
router.get("/wallet/transactions", authenticate, authorize(["HOST", "BOTH"]), walletTransactions);
// Debug host status
router.get("/debug/host-status", authenticate, authorize(["HOST", "BOTH"]), debugHostStatus);

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
      const allowed = new Set([
        "checkout.session.completed",
        "payment_intent.succeeded",
        "payment_intent.payment_failed",
        "charge.refunded",
        "refund.updated",
        "charge.dispute.created",
        "charge.dispute.closed",
        "account.updated",
        "account.external_account.created",
        "account.external_account.updated",
        "account.external_account.deleted",
      ]);
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
          const matchedUsers = await User.find({ stripeAccountId: id }).select("_id email").lean();
          if (matchedUsers.length > 1) {
            console.error("Stripe account linked to multiple users", {
              accountId: id,
              userIds: matchedUsers.map((row) => String(row._id)),
            });
          }
          const updated = await User.updateMany(
            { stripeAccountId: id },
            {
              isStripeChargesEnabled: !!charges_enabled,
              isStripePayoutsEnabled: !!payouts_enabled,
              isStripeDetailsSubmitted: !!details_submitted,
            },
            {}
          );
          console.log("Stripe webhook account.updated -> user updated", {
            accountId: id,
            charges_enabled,
            payouts_enabled,
            details_submitted,
            userFound: matchedUsers.length > 0,
            matchedUsers: matchedUsers.length,
            modifiedUsers: Number(updated?.modifiedCount || 0),
          });
          if (id) {
            try {
              await syncHostComplianceSnapshot({
                stripeAccountId: id,
                triggerType: "webhook",
                triggerEventId: event.id,
                triggerEventType: event.type,
                metadata: { reason: "account_updated" },
              });
            } catch (err) {
              console.error("Stripe compliance sync (account.updated) error", err?.message || err);
            }
          }
          break;
        }
        case "account.external_account.created":
        case "account.external_account.updated":
        case "account.external_account.deleted": {
          const externalAccount = event.data.object || {};
          const accountId = String(externalAccount.account || "").trim();
          if (accountId) {
            try {
              await syncHostComplianceSnapshot({
                stripeAccountId: accountId,
                triggerType: "webhook",
                triggerEventId: event.id,
                triggerEventType: event.type,
                metadata: {
                  reason: "external_account_changed",
                  externalAccountId: String(externalAccount.id || ""),
                },
              });
            } catch (err) {
              console.error("Stripe compliance sync (external account) error", err?.message || err);
            }
          }
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
          const paymentIntentId = pi.id;
          const chargeId = pi.latest_charge || pi.charges?.data?.[0]?.id;
          const amount = pi.amount_received || pi.amount || 0;
          const currency = pi.currency || "ron";
          const bookingId = pi.metadata?.bookingId;
          const hostId = pi.metadata?.hostId;
          const explorerId = pi.metadata?.explorerId;
          const stripeAccountId = pi.metadata?.hostStripeAccountId || pi.transfer_data?.destination || null;
          const chargeModel = String(pi.metadata?.chargeModel || "");

          let payment = null;
          if (paymentIntentId) {
            payment = await Payment.findOne({ stripePaymentIntentId: paymentIntentId });
          }
          if (!payment && chargeId) {
            payment = await Payment.findOne({ stripeChargeId: chargeId });
          }
          if (!payment && bookingId) {
            payment = await Payment.findOne({ booking: bookingId });
          }
          if (payment) {
            payment.status = "CONFIRMED";
            payment.stripeChargeId = chargeId || payment.stripeChargeId;
            payment.amount = amount || payment.amount;
            payment.currency = currency || payment.currency;
            payment.host = payment.host || hostId || payment.host;
            payment.explorer = payment.explorer || explorerId || payment.explorer;
            payment.stripeAccountId = payment.stripeAccountId || stripeAccountId;
            if (chargeModel) {
              payment.chargeModel = chargeModel;
            }
            await payment.save();
          }

          const resolvedChargeModel = String(payment?.chargeModel || chargeModel || "DESTINATION_CHARGE");
          if (hostId && resolvedChargeModel !== "SEPARATE_CHARGE_AND_TRANSFER") {
            await Transaction.findOneAndUpdate(
              { stripePaymentIntentId: paymentIntentId },
              {
                user: hostId,
                booking: payment?.booking,
                stripeAccountId: stripeAccountId,
                amount,
                currency,
                type: "payment",
                stripePaymentIntentId: paymentIntentId,
                stripeChargeId: chargeId,
                status: "CONFIRMED",
                platformFee: payment?.platformFee || payment?.livadaiFee || 0,
              },
              { upsert: true, new: true }
            );
          }
          break;
        }
        case "payment_intent.payment_failed": {
          const pi = event.data.object;
          const paymentIntentId = pi.id;
          if (paymentIntentId) {
            await Payment.findOneAndUpdate(
              { stripePaymentIntentId: paymentIntentId },
              { status: "FAILED" },
              { new: true }
            );
          }
          break;
        }
        case "charge.refunded": {
          const charge = event.data.object;
          const paymentIntentId = charge.payment_intent;
          const chargeId = charge.id;
          const payment =
            (paymentIntentId && (await Payment.findOne({ stripePaymentIntentId: paymentIntentId }))) ||
            (chargeId && (await Payment.findOne({ stripeChargeId: chargeId })));
          if (payment) {
            payment.status = "REFUNDED";
            payment.stripeChargeId = payment.stripeChargeId || chargeId;
            await payment.save();
            const booking = await Booking.findById(payment.booking);
            if (booking) {
              if (booking.status !== "CANCELLED") {
                booking.status = "REFUNDED";
              }
              booking.refundedAt = new Date();
              await booking.save();
            }
          }
          break;
        }
        case "refund.updated": {
          const refund = event.data.object;
          const chargeId = refund.charge;
          if (refund.status !== "succeeded") break;
          const payment = chargeId ? await Payment.findOne({ stripeChargeId: chargeId }) : null;
          if (payment) {
            payment.status = "REFUNDED";
            await payment.save();
            const booking = await Booking.findById(payment.booking);
            if (booking) {
              if (booking.status !== "CANCELLED") {
                booking.status = "REFUNDED";
              }
              booking.refundedAt = new Date();
              await booking.save();
            }
          }
          break;
        }
        case "charge.dispute.created": {
          const dispute = event.data.object;
          const chargeId = dispute.charge;
          const payment = chargeId ? await Payment.findOne({ stripeChargeId: chargeId }) : null;
          if (payment) {
            payment.status = "DISPUTED";
            await payment.save();
            const booking = await Booking.findById(payment.booking);
            if (booking) {
              booking.status = "DISPUTED";
              booking.disputedAt = booking.disputedAt || new Date();
              booking.disputeResolvedAt = null;
              await booking.save();
              const existing = await Report.findOne({
                booking: booking._id,
                type: { $in: ["BOOKING_DISPUTE", "STRIPE_DISPUTE"] },
              });
              if (!existing) {
                await Report.create({
                  type: "STRIPE_DISPUTE",
                  experience: booking.experience,
                  booking: booking._id,
                  host: booking.host,
                  targetType: "USER",
                  targetUserId: booking.host,
                  reason: "STRIPE_DISPUTE",
                  comment: dispute.reason || null,
                  affectsPayout: false,
                  deadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
                });
              }
            }
          }
          break;
        }
        case "charge.dispute.closed": {
          const dispute = event.data.object;
          const chargeId = dispute.charge;
          const resolution = dispute.status;
          const resolvedStatus = resolution === "won" ? "DISPUTE_WON" : "DISPUTE_LOST";
          const payment = chargeId ? await Payment.findOne({ stripeChargeId: chargeId }) : null;
          if (payment) {
            payment.status = resolvedStatus;
            await payment.save();
            const booking = await Booking.findById(payment.booking);
            if (booking) {
              booking.status = resolvedStatus;
              booking.disputeResolvedAt = new Date();
              if (resolvedStatus === "DISPUTE_WON" && booking.completedAt && !booking.payoutEligibleAt) {
                booking.payoutEligibleAt = new Date(booking.completedAt.getTime() + 72 * 60 * 60 * 1000);
              }
              await booking.save();
              const report = await Report.findOne({
                booking: booking._id,
                type: { $in: ["BOOKING_DISPUTE", "STRIPE_DISPUTE"] },
                status: "OPEN",
              });
              if (report) {
                report.status = "HANDLED";
                report.handledAt = new Date();
                report.actionTaken = resolvedStatus;
                await report.save();
              }
            }
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
