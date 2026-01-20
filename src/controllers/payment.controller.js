const stripe = require("../config/stripe");
const { isPayoutEligible, logPayoutAttempt } = require("../utils/payout");
const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const Payment = require("../models/payment.model");
const { createNotification } = require("./notifications.controller");
const { sendEmail } = require("../utils/mailer");
const { buildBookingConfirmedEmail } = require("../utils/emailTemplates");
const User = require("../models/user.model");

// New checkout flow: experienceId + quantity
const createCheckout = async (req, res) => {
  try {
    const { experienceId, quantity } = req.body;
    const qty = Math.max(1, Number(quantity) || 1);
    if (!experienceId) return res.status(400).json({ message: "experienceId required" });

    const exp = await Experience.findById(experienceId);
    if (!exp || exp.isActive === false || exp.status === "DISABLED") return res.status(404).json({ message: "Experience not available" });
    // explorer banned?
    const explorer = await User.findById(req.user.id);
    if (explorer?.isBanned) return res.status(403).json({ message: "Explorer banned" });
    // host banned?
    const host = await User.findById(exp.host);
    if (host?.isBanned) return res.status(403).json({ message: "Host banned / experience disabled" });
    const now = new Date();
    const starts = exp.startsAt || exp.startDate;
    if (starts && new Date(starts) <= now) {
      return res.status(400).json({ message: "Experience has already started and cannot be booked." });
    }

    // availability rules
    if (exp.activityType === "INDIVIDUAL" && qty !== 1) {
      return res.status(400).json({ message: "Individual activity allows a single seat" });
    }
    const available = exp.remainingSpots ?? exp.maxParticipants ?? 1;
    if (available < qty || exp.soldOut) {
      return res.status(400).json({ message: "Not enough spots available" });
    }

    // Anti-abuse: block free bookings if too many no-shows in last 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const isFree = !exp.price || Number(exp.price) <= 0;
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
    const depositAmountMinor = 5 * 100;
    const unitAmount = isFree ? depositAmountMinor : Math.round((exp.price || 0) * 100);
    const amount = unitAmount * qty;
    if (amount <= 0) return res.status(400).json({ message: "Invalid price" });

    const booking = await Booking.create({
      experience: exp._id,
      explorer: req.user.id,
      host: exp.host,
      quantity: qty,
      amount: isFree ? 0 : amount,
      currency: baseCurrency,
      depositAmount: isFree ? amount : 0,
      depositCurrency: isFree ? depositCurrency : undefined,
      status: "PENDING",
    });

    const baseUrl = process.env.FRONTEND_URL || process.env.APP_URL || "https://app.livadai.com";
    const successUrl = `${baseUrl.replace(/\/$/, "")}/payment-success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${baseUrl.replace(/\/$/, "")}/payment-cancel`;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: isFree ? depositCurrency : baseCurrency,
            product_data: { name: isFree ? `Deposit for ${exp.title || "Experience"}` : exp.title || "Experience" },
            unit_amount: unitAmount,
          },
          quantity: qty,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        bookingId: booking._id.toString(),
        experienceId: exp._id.toString(),
        explorerId: (req.user?._id || req.user?.id)?.toString(),
        quantity: qty.toString(),
        isDeposit: isFree ? "true" : "false",
      },
    });

    await Payment.findOneAndUpdate(
      { booking: booking._id },
      {
        booking: booking._id,
        stripePaymentIntentId: session.payment_intent,
        stripeSessionId: session.id,
        amount,
        paymentType: isFree ? "DEPOSIT" : "PAID_BOOKING",
        status: "INITIATED",
      },
      { upsert: true, new: true }
    );

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

  // Update payment record
  await Payment.findOneAndUpdate(
    { booking: bookingId },
    {
      stripePaymentIntentId: paymentIntentId,
      stripeSessionId: sessionId,
      status: "CONFIRMED",
    },
    { upsert: true }
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
      const html = buildBookingConfirmedEmail({
        experience: exp,
        bookingId: booking._id,
        ctaUrl: explorerBookingsLink,
        role: "explorer",
      });
      await sendEmail({
        to: explorer.email,
        subject: "Booking confirmat / Booking confirmed – LIVADAI",
        html,
        type: "booking_explorer",
        userId: explorer._id,
      });
    }

    if (host?.email) {
      const html = buildBookingConfirmedEmail({
        experience: exp,
        bookingId: booking._id,
        ctaUrl: hostBookingsLink,
        role: "host",
      });
      await sendEmail({
        to: host.email,
        subject: "Rezervare confirmată / Booking confirmed – LIVADAI",
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
