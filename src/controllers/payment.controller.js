const stripe = require("../config/stripe");
const { isPayoutEligible, logPayoutAttempt } = require("../utils/payout");
const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const Payment = require("../models/payment.model");
const { createNotification } = require("./notifications.controller");
const { sendEmail } = require("../utils/mailer");
const { buildBookingConfirmedEmail, formatExperienceDate } = require("../utils/emailTemplates");
const User = require("../models/user.model");
const { readRequestAnalyticsContext, trackServerEvent } = require("../utils/analytics");
const { HOST_FEE_MODES, calculateHostFeeBreakdown, getSavedHostStripeFeeConfig, normalizeHostFeeMode } = require("../utils/hostFeePolicy");

// New checkout flow: experienceId + quantity
const createCheckout = async (req, res) => {
  try {
    const { experienceId, quantity } = req.body;
    const analyticsContext = readRequestAnalyticsContext(req);
    const requestedQty = Math.max(1, Number(quantity) || 1);
    if (!experienceId) return res.status(400).json({ message: "experienceId required" });

    const exp = await Experience.findById(experienceId);
    if (!exp || exp.isActive === false || exp.status === "DISABLED") return res.status(404).json({ message: "Experience not available" });
    if (exp.host?.toString?.() === req.user.id) {
      return res.status(403).json({ message: "Cannot book your own experience" });
    }
    // explorer banned?
    const explorer = await User.findById(req.user.id);
    if (explorer?.isBanned) return res.status(403).json({ message: "Explorer banned" });
    // host banned?
    const host = await User.findById(exp.host);
    if (host?.isBanned) return res.status(403).json({ message: "Host banned / experience disabled" });
    const isFree = !exp.price || Number(exp.price) <= 0;
    if (!isFree) {
      if (!host?.stripeAccountId || !host?.isStripeChargesEnabled) {
        if (host?.stripeAccountId) {
          try {
            const acct = await stripe.accounts.retrieve(host.stripeAccountId);
            host.isStripeChargesEnabled = !!acct?.charges_enabled;
            host.isStripePayoutsEnabled = !!acct?.payouts_enabled;
            host.isStripeDetailsSubmitted = !!acct?.details_submitted;
            await host.save();
          } catch (err) {
            console.error("Stripe account refresh failed", err?.message || err);
          }
        }
        if (!host?.stripeAccountId || !host?.isStripeChargesEnabled) {
          return res.status(400).json({ message: "Host payout account not ready" });
        }
      }
    }
    const now = new Date();
    const starts = exp.startsAt || exp.startDate;
    if (starts && new Date(starts) <= now) {
      return res.status(400).json({ message: "Experience has already started and cannot be booked." });
    }

    const pricingMode = String(exp.pricingMode || "").toUpperCase() === "PER_GROUP" ? "PER_GROUP" : "PER_PERSON";
    const groupPackageSize = Math.max(1, Number(exp.groupPackageSize) || Number(exp.maxParticipants) || 1);
    let seatQty = exp.activityType === "INDIVIDUAL" ? 1 : requestedQty;
    if (pricingMode === "PER_GROUP") {
      seatQty = groupPackageSize;
    }

    // availability rules
    if (exp.activityType === "INDIVIDUAL" && seatQty !== 1) {
      return res.status(400).json({ message: "Individual activity allows a single seat" });
    }
    const available = exp.remainingSpots ?? exp.maxParticipants ?? 1;
    if (available < seatQty || exp.soldOut) {
      return res.status(400).json({ message: "Not enough spots available" });
    }

    // Anti-abuse: block free bookings if too many no-shows in last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const isServiceFee = isFree;
    if (isFree) {
      const noShows = await Booking.countDocuments({
        explorer: req.user.id,
        attendanceStatus: "NO_SHOW",
        createdAt: { $gte: thirtyDaysAgo },
      });
      if (noShows >= 2) {
        return res.status(403).json({ message: "Booking blocked due to repeated no-shows in the last 30 days." });
      }
    }

    const baseCurrency = "ron";
    const depositCurrency = "ron";
    const serviceFeeAmountMinor = 2 * 100;
    const unitAmount = isServiceFee ? serviceFeeAmountMinor : Math.round((exp.price || 0) * 100);
    const checkoutQuantity = !isServiceFee && pricingMode === "PER_GROUP" ? 1 : seatQty;
    const amount = unitAmount * checkoutQuantity;
    if (amount <= 0) return res.status(400).json({ message: "Invalid price" });

    let booking = await Booking.findOne({
      experience: exp._id,
      explorer: req.user.id,
      host: exp.host,
      status: "PENDING",
    }).sort({ updatedAt: -1, createdAt: -1 });

    if (booking) {
      booking.quantity = seatQty;
      booking.amount = amount;
      booking.currency = baseCurrency;
      booking.depositAmount = 0;
      booking.depositCurrency = undefined;
      booking.status = "PENDING";
      await booking.save();
    } else {
      booking = await Booking.create({
        experience: exp._id,
        explorer: req.user.id,
        host: exp.host,
        quantity: seatQty,
        amount: amount,
        currency: baseCurrency,
        depositAmount: 0,
        depositCurrency: undefined,
        status: "PENDING",
      });
    }

    const baseUrl = process.env.FRONTEND_URL || process.env.APP_URL || "https://app.livadai.com";
    const appScheme = process.env.APP_DEEP_LINK_SCHEME || "livadaiapp";
    const successUrl = req.body?.returnToApp
      ? `${appScheme}://payment-success?session_id={CHECKOUT_SESSION_ID}`
      : `${baseUrl.replace(/\/$/, "")}/payment-success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl.replace(/\/$/, "")}/payment-cancel`;
    const hostFeeMode = normalizeHostFeeMode(host?.hostFeeMode);
    const hostStripeFeeConfig = getSavedHostStripeFeeConfig(host);
    const paymentSplit = isServiceFee
      ? {
          modeApplied: HOST_FEE_MODES.STANDARD,
          platformFeeMinor: 0,
          transferAmountMinor: 0,
          hostNetAmountMinor: 0,
          estimatedStripeFeeMinor: 0,
        }
      : calculateHostFeeBreakdown({
          amountMinor: amount,
          feeMode: hostFeeMode,
          stripeFeeConfig: hostStripeFeeConfig,
        });

    if (paymentSplit.errorCode === "HOST_PAYS_STRIPE_CONFIG_MISSING") {
      return res.status(503).json({ message: "Host fee policy is not configured correctly. Please contact support." });
    }
    if (paymentSplit.errorCode === "HOST_NET_AMOUNT_TOO_LOW") {
      return res.status(400).json({ message: "Experience price is too low for the selected host fee policy." });
    }

    const platformFeeMinor = Number(paymentSplit.platformFeeMinor || 0);
    const paymentIntentData = {
      metadata: {
        bookingId: booking._id.toString(),
        experienceId: exp._id.toString(),
        explorerId: (req.user?._id || req.user?.id)?.toString(),
        hostId: exp.host?.toString?.() || exp.host?.toString?.(),
        isServiceFee: isServiceFee ? "true" : "false",
        hostFeeMode: paymentSplit.modeApplied,
        platformFeeMinor: String(platformFeeMinor),
        estimatedStripeFeeMinor: String(paymentSplit.estimatedStripeFeeMinor || 0),
        hostNetAmountMinor: String(paymentSplit.hostNetAmountMinor || 0),
      },
    };
    if (!isServiceFee) {
      paymentIntentData.transfer_data = { destination: host.stripeAccountId };
      if (paymentSplit.modeApplied === HOST_FEE_MODES.HOST_PAYS_STRIPE) {
        paymentIntentData.transfer_data.amount = paymentSplit.transferAmountMinor;
      } else if (platformFeeMinor > 0) {
        paymentIntentData.application_fee_amount = platformFeeMinor;
      }
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      payment_intent_data: paymentIntentData,
      line_items: [
        {
          price_data: {
            currency: isServiceFee ? depositCurrency : baseCurrency,
            product_data: { name: isServiceFee ? `Service fee for ${exp.title || "Experience"}` : exp.title || "Experience" },
            unit_amount: unitAmount,
          },
          quantity: checkoutQuantity,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        bookingId: booking._id.toString(),
        experienceId: exp._id.toString(),
        explorerId: (req.user?._id || req.user?.id)?.toString(),
        quantity: seatQty.toString(),
        checkoutQuantity: checkoutQuantity.toString(),
        pricingMode,
        isDeposit: "false",
        isServiceFee: isServiceFee ? "true" : "false",
      },
    });

    const paymentDoc = await Payment.findOneAndUpdate(
      { booking: booking._id },
      {
        booking: booking._id,
        host: exp.host,
        explorer: req.user.id,
        stripeAccountId: host.stripeAccountId,
        stripePaymentIntentId: session.payment_intent,
        stripeSessionId: session.id,
        amount,
        totalAmount: amount,
        currency: isServiceFee ? depositCurrency : baseCurrency,
        platformFee: platformFeeMinor,
        hostFeeMode: paymentSplit.modeApplied,
        transferAmount: Number(paymentSplit.transferAmountMinor || 0),
        hostNetAmount: Number(paymentSplit.hostNetAmountMinor || 0),
        estimatedStripeFee: Number(paymentSplit.estimatedStripeFeeMinor || 0),
        paymentType: isServiceFee ? "SERVICE_FEE" : "PAID_BOOKING",
        analytics: {
          anonymousId: analyticsContext.anonymousId,
          sessionId: analyticsContext.sessionId,
          source: analyticsContext.source,
          medium: analyticsContext.medium,
          campaign: analyticsContext.campaign,
          channelGroup: analyticsContext.channelGroup,
          landingPage: analyticsContext.landingPage,
          page: analyticsContext.page,
          path: analyticsContext.path,
          platform: analyticsContext.platform,
        },
        status: "INITIATED",
      },
      { upsert: true, new: true }
    );

    await trackServerEvent({
      req,
      eventName: "checkout_started",
      userId: req.user.id,
      platform: analyticsContext.platform || "web",
      context: analyticsContext,
      experienceId: exp._id,
      hostId: exp.host,
      bookingId: booking._id,
      paymentId: paymentDoc?._id,
      properties: {
        pricingMode,
        quantity: seatQty,
        checkoutQuantity,
        isServiceFee,
        hostFeeMode: paymentSplit.modeApplied,
        platformFeeMinor,
        estimatedStripeFeeMinor: Number(paymentSplit.estimatedStripeFeeMinor || 0),
      },
    });

    return res.json({ checkoutUrl: session.url, bookingId: booking._id });
  } catch (err) {
    console.error("Create checkout error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const handlePaymentSuccess = async ({ bookingId, paymentIntentId, sessionId, isDeposit }) => {
  if (!bookingId) return;
  const booking = await Booking.findById(bookingId);
  if (!booking) return;

  const alreadyPaid = booking.status === "PAID" || booking.status === "DEPOSIT_PAID";

  if (!alreadyPaid) {
    booking.status = isDeposit ? "DEPOSIT_PAID" : "PAID";
    await booking.save();
  }

  try {
    const siblingPendingBookings = await Booking.find({
      _id: { $ne: booking._id },
      experience: booking.experience,
      explorer: booking.explorer,
      host: booking.host,
      status: { $in: ["PENDING", "CONFIRMED"] },
    }).select("_id");

    if (siblingPendingBookings.length) {
      const siblingIds = siblingPendingBookings.map((row) => row._id);
      const confirmedSiblingPayments = await Payment.find({
        booking: { $in: siblingIds },
        status: "CONFIRMED",
      }).select("booking");

      const protectedBookingIds = new Set(
        confirmedSiblingPayments.map((payment) => String(payment.booking?.toString?.() || payment.booking))
      );

      const cancellableIds = siblingIds.filter((id) => !protectedBookingIds.has(String(id)));
      if (cancellableIds.length) {
        await Booking.updateMany(
          { _id: { $in: cancellableIds } },
          {
            $set: {
              status: "CANCELLED",
              cancelledAt: new Date(),
            },
          }
        );
      }
    }
  } catch (err) {
    console.error("Booking sibling cleanup error", err?.message || err);
  }

  // Update payment record
  const paymentDoc = await Payment.findOneAndUpdate(
    { booking: bookingId },
    {
      stripePaymentIntentId: paymentIntentId,
      stripeSessionId: sessionId,
      status: "CONFIRMED",
    },
    { upsert: true, new: true }
  );

  if (alreadyPaid) {
    return;
  }

  // Decrement availability
  const exp = await Experience.findById(booking.experience);
  if (!exp) return;
  const remaining = (exp.remainingSpots ?? exp.maxParticipants ?? 1) - (booking.quantity || 1);
  exp.remainingSpots = Math.max(0, remaining);
  if (exp.remainingSpots <= 0) {
    exp.soldOut = true;
    exp.isActive = false; // hide from list/map
  }
  await exp.save();

  const analyticsContext = paymentDoc?.analytics || {};
  await trackServerEvent({
    eventName: "payment_completed",
    userId: booking.explorer,
    platform: analyticsContext.platform || "server",
    context: analyticsContext,
    experienceId: exp._id,
    hostId: booking.host,
    bookingId: booking._id,
    paymentId: paymentDoc?._id,
    properties: {
      amountMinor: paymentDoc?.totalAmount || paymentDoc?.amount || booking.amount || 0,
      currency: paymentDoc?.currency || booking.currency || "ron",
      isDeposit: !!isDeposit,
    },
  });
  await trackServerEvent({
    eventName: "booking_confirmed",
    userId: booking.explorer,
    platform: analyticsContext.platform || "server",
    context: analyticsContext,
    experienceId: exp._id,
    hostId: booking.host,
    bookingId: booking._id,
    paymentId: paymentDoc?._id,
    properties: {
      amountMinor: paymentDoc?.totalAmount || paymentDoc?.amount || booking.amount || 0,
      currency: paymentDoc?.currency || booking.currency || "ron",
    },
  });

  // Notifications: explorer + host
  try {
    const explorer = await User.findById(booking.explorer);
    const host = await User.findById(booking.host);
    const spots = booking.quantity || 1;
    await createNotification({
      user: booking.explorer,
      type: "BOOKING_CONFIRMED",
      title: "Booking confirmed",
      message: isDeposit
        ? `Deposit paid for "${exp.title}". Attendance required to refund.`
        : `Your spot for "${exp.title}" is confirmed.`,
      data: { activityId: exp._id, bookingId: booking._id, activityTitle: exp.title, spots },
      push: true,
    });
    if (host) {
      await createNotification({
        user: host._id,
        type: "BOOKING_RECEIVED",
        title: "New booking received",
        message: `${explorer?.name || "An explorer"} booked ${booking.quantity || 1} spot(s) for "${exp.title}".`,
        data: {
          activityId: exp._id,
          bookingId: booking._id,
          activityTitle: exp.title,
          bookedBy: explorer?.name || "Someone",
          spots,
        },
        push: true,
      });
    }
  } catch (err) {
    console.error("Notification booking success error", err);
  }

  // Email: explorer + host
  try {
    const explorer = await User.findById(booking.explorer);
    const host = await User.findById(booking.host);
    const appUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
    const explorerBookingsLink = `${appUrl.replace(/\/$/, "")}/my-activities`;
    const hostBookingsLink = `${appUrl.replace(/\/$/, "")}/profile`;

    if (explorer?.email) {
      const totalSeats = exp.maxParticipants || 1;
      const remainingSeats = typeof exp.remainingSpots === "number" ? exp.remainingSpots : Math.max(0, totalSeats - (booking.quantity || 1));
      const dateLabel = formatExperienceDate(exp);
      const html = buildBookingConfirmedEmail({
        experience: exp,
        bookingId: booking._id,
        ctaUrl: explorerBookingsLink,
        role: "explorer",
        seatsBooked: booking.quantity || 1,
        totalSeats,
        remainingSeats,
      });
      await sendEmail({
        to: explorer.email,
        subject: `Booking confirmat: ${exp?.title || "LIVADAI"} – ${dateLabel} (#${booking._id})`,
        html,
        type: "booking_explorer",
        userId: explorer._id,
      });
    }

    if (host?.email) {
      const totalSeats = exp.maxParticipants || 1;
      const remainingSeats = typeof exp.remainingSpots === "number" ? exp.remainingSpots : Math.max(0, totalSeats - (booking.quantity || 1));
      const dateLabel = formatExperienceDate(exp);
      const html = buildBookingConfirmedEmail({
        experience: exp,
        bookingId: booking._id,
        ctaUrl: hostBookingsLink,
        role: "host",
        seatsBooked: booking.quantity || 1,
        totalSeats,
        remainingSeats,
      });
      await sendEmail({
        to: host.email,
        subject: `Rezervare confirmată: ${exp?.title || "LIVADAI"} – ${dateLabel} (#${booking._id})`,
        html,
        type: "booking_host",
        userId: host._id,
      });
    }
  } catch (err) {
    console.error("Booking email error", err);
  }
};

module.exports = { createCheckout, handlePaymentSuccess };
