const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const Report = require("../models/report.model");
const Review = require("../models/review.model");
const { createNotification } = require("./notifications.controller");
const User = require("../models/user.model");
const Payment = require("../models/payment.model");
const stripe = require("../config/stripe");
const jwt = require("jsonwebtoken");
const { sendEmail } = require("../utils/mailer");
const { buildDisputeOpenedEmail, buildBookingCancelledEmail, formatExperienceDate } = require("../utils/emailTemplates");
const { isPayoutEligible, logPayoutAttempt } = require("../utils/payout");
const { sendContentReportEmail, sendDisputeEmail, sendUserReportEmail } = require("../utils/reports");
const { recalcTrustedParticipant } = require("../utils/trust");
const { trackServerEvent } = require("../utils/analytics");
const { refundPaymentRecord } = require("../utils/stripeRefunds");

const FALLBACK_EXPERIENCE_DURATION_MINUTES = 120;
const reviewEligibleStatuses = new Set([
  "COMPLETED",
  "AUTO_COMPLETED",
  "PAID",
  "DEPOSIT_PAID",
  "CONFIRMED",
]);
const pendingBookingStatuses = new Set(["PENDING", "CONFIRMED"]);
const bookingStatusPriority = {
  DISPUTE_WON: 120,
  DISPUTED: 115,
  DISPUTE_LOST: 110,
  REFUNDED: 105,
  REFUND_FAILED: 100,
  COMPLETED: 95,
  AUTO_COMPLETED: 90,
  NO_SHOW: 85,
  PAID: 70,
  DEPOSIT_PAID: 65,
  CANCELLED: 60,
  CONFIRMED: 20,
  PENDING: 10,
};

const toTimestamp = (value) => {
  if (!value) return 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
};

const getBookingExplorerExperienceKey = (booking) => {
  const explorerId =
    booking?.explorer?._id?.toString?.() ||
    booking?.explorer?.id?.toString?.() ||
    (typeof booking?.explorer === "string" ? booking.explorer : "") ||
    booking?.explorer?.email ||
    booking?.explorer?.phone ||
    booking?.explorer?.displayName ||
    booking?.explorer?.name ||
    "";
  const experienceId =
    booking?.experience?._id?.toString?.() ||
    booking?.experience?.id?.toString?.() ||
    (typeof booking?.experience === "string" ? booking.experience : "") ||
    [
      booking?.experience?.title,
      booking?.experience?.startsAt || booking?.experience?.startDate || booking?.date,
      booking?.timeSlot,
    ]
      .filter(Boolean)
      .join("::");
  if (!explorerId || !experienceId) return "";
  return `${explorerId}::${experienceId}`;
};

const selectPreferredBooking = (bookings = []) =>
  bookings
    .slice()
    .sort((a, b) => {
      const aPending = pendingBookingStatuses.has(String(a?.status || ""));
      const bPending = pendingBookingStatuses.has(String(b?.status || ""));
      if (aPending !== bPending) return aPending ? 1 : -1;
      const aTime = toTimestamp(a?.updatedAt) || toTimestamp(a?.createdAt);
      const bTime = toTimestamp(b?.updatedAt) || toTimestamp(b?.createdAt);
      if (aTime !== bTime) return bTime - aTime;
      const aPriority = bookingStatusPriority[String(a?.status || "")] || 0;
      const bPriority = bookingStatusPriority[String(b?.status || "")] || 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return bTime - aTime;
    })[0] || null;

const dedupeBookingSnapshots = (bookings = []) => {
  const groups = new Map();
  bookings.forEach((booking) => {
    const key = getBookingExplorerExperienceKey(booking);
    if (!key) return;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(booking);
  });

  const keepIds = new Set();
  bookings.forEach((booking) => {
    const key = getBookingExplorerExperienceKey(booking);
    if (!key) keepIds.add(String(booking._id));
  });

  groups.forEach((group) => {
    const preferredBooking = selectPreferredBooking(group);
    if (preferredBooking?._id) keepIds.add(String(preferredBooking._id));
  });

  return bookings.filter((booking) => keepIds.has(String(booking._id)));
};

const hydrateBookingsWithPaymentState = async (bookings = []) => {
  const bookingIds = bookings.map((booking) => booking?._id).filter(Boolean);
  let confirmedPayments = [];
  if (bookingIds.length) {
    try {
      confirmedPayments = await Payment.find({ booking: { $in: bookingIds }, status: "CONFIRMED" }).select("booking paymentType");
    } catch (_err) {
      confirmedPayments = [];
    }
  }

  const paymentMap = new Map();
  confirmedPayments.forEach((payment) => {
    const id = payment.booking?.toString?.() || payment.booking;
    if (id) paymentMap.set(String(id), payment.paymentType || "PAID_BOOKING");
  });

  const pendingUpdates = [];
  const normalized = bookings.map((booking) => {
    const obj = booking?.toObject ? booking.toObject() : { ...booking };
    const paymentType = paymentMap.get(String(booking._id));
    let effectiveStatus = obj.status;
    if (paymentType && pendingBookingStatuses.has(String(obj.status || ""))) {
      effectiveStatus = paymentType === "DEPOSIT" ? "DEPOSIT_PAID" : "PAID";
      pendingUpdates.push({ bookingId: booking._id, currentStatus: booking.status, status: effectiveStatus });
    }
    return {
      ...obj,
      status: effectiveStatus,
      paymentConfirmed: !!paymentType,
    };
  });

  if (pendingUpdates.length) {
    try {
      await Booking.bulkWrite(
        pendingUpdates.map((item) => ({
          updateOne: {
            filter: { _id: item.bookingId, status: item.currentStatus },
            update: { $set: { status: item.status } },
          },
        }))
      );
    } catch (_err) {
      // ignore background status repair failures
    }
  }

  return dedupeBookingSnapshots(normalized);
};

const getExperienceEndDate = (exp) => {
  if (!exp) return null;
  const rawEnd = exp.endsAt || exp.endDate;
  if (rawEnd) {
    const endDate = new Date(rawEnd);
    if (!Number.isNaN(endDate.getTime())) return endDate;
  }
  const rawStart = exp.startsAt || exp.startDate;
  if (rawStart && exp.durationMinutes) {
    const startDate = new Date(rawStart);
    if (!Number.isNaN(startDate.getTime())) {
      return new Date(startDate.getTime() + Number(exp.durationMinutes) * 60 * 1000);
    }
  }
  if (rawStart) {
    const startDate = new Date(rawStart);
    if (!Number.isNaN(startDate.getTime())) {
      return new Date(startDate.getTime() + FALLBACK_EXPERIENCE_DURATION_MINUTES * 60 * 1000);
    }
  }
  return null;
};

const isDisputeLocked = (booking) => {
  if (!booking?.status) return false;
  return ["DISPUTED", "DISPUTE_WON", "DISPUTE_LOST"].includes(booking.status);
};

const createBooking = async (req, res) => {
  try {
    const { experienceId, date, timeSlot } = req.body;
    if (!experienceId || !date || !timeSlot) {
      return res.status(400).json({ message: "experienceId, date, timeSlot required" });
    }

    const explorerUser = await User.findById(req.user.id);
    if (explorerUser?.isBanned) return res.status(403).json({ message: "Explorer banned" });

    const experience = await Experience.findById(experienceId);
    if (!experience || experience.isActive === false || experience.status === "DISABLED") {
      return res.status(404).json({ message: "Experience not found" });
    }
    const hostUser = await User.findById(experience.host);
    if (hostUser?.isBanned) return res.status(403).json({ message: "Host banned / experience disabled" });

    if (experience.soldOut || experience.remainingSpots <= 0) {
      return res.status(400).json({ message: "Activity sold out" });
    }

    // 1 booking = 1 seat
    const newRemaining = (experience.remainingSpots || 1) - 1;
    experience.remainingSpots = newRemaining;
    if (newRemaining <= 0) {
      experience.soldOut = true;
      experience.remainingSpots = 0;
    }
    await experience.save();

    const booking = await Booking.create({
      experience: experienceId,
      explorer: req.user.id,
      host: experience.host,
      date,
      timeSlot,
      status: "PENDING",
    });

    await trackServerEvent({
      req,
      eventName: "booking_created",
      userId: req.user.id,
      platform: "server",
      experienceId: experience._id,
      hostId: experience.host,
      bookingId: booking._id,
      properties: {
        date,
        timeSlot,
      },
    });

    // Notify host of new booking request
    try {
      const explorer = await User.findById(req.user.id);
      const spots = 1;
      await createNotification({
        user: experience.host,
        type: "BOOKING_RECEIVED",
        title: "New booking received",
        message: `${explorer?.name || "An explorer"} requested a booking for "${experience.title}".`,
        data: {
          activityId: experience._id,
          bookingId: booking._id,
          activityTitle: experience.title,
          bookedBy: explorer?.name || "Someone",
          spots,
        },
      });
    } catch (err) {
      console.error("Notify host booking request error", err);
    }

    return res.status(201).json(booking);
  } catch (err) {
    console.error("Create booking error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getMyBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ explorer: req.user.id })
      .populate(
        "experience",
        "title price currencyCode startDate endDate startsAt endsAt durationMinutes startTime endTime activityType remainingSpots maxParticipants soldOut host address"
      )
      .populate("host", "name");
    const hydratedBookings = await hydrateBookingsWithPaymentState(bookings);
    const bookingIds = hydratedBookings.map((b) => b._id);
    const existingReviews = await Review.find({ booking: { $in: bookingIds } }).select("booking user");
    const reviewedMap = new Set(existingReviews.map((r) => `${r.booking.toString()}::${r.user.toString()}`));
    const now = new Date();
    const data = hydratedBookings.map((b) => {
      const exp = b.experience;
      const endDate = getExperienceEndDate(exp);
      const eligible =
        reviewEligibleStatuses.has(String(b.status || "")) &&
        endDate &&
        !Number.isNaN(endDate.getTime()) &&
        now > endDate;
      const reviewKey = `${b._id.toString()}::${req.user.id}`;
      return {
        ...b,
        reviewEligible: !!eligible && !reviewedMap.has(reviewKey),
        reviewExists: reviewedMap.has(reviewKey),
      };
    });
    return res.json(data);
  } catch (err) {
    console.error("Get my bookings error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getHostBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ host: req.user.id })
      .populate("experience", "title price startsAt endsAt startDate endDate activityType remainingSpots maxParticipants")
      .populate("explorer", "name email");
    const data = await hydrateBookingsWithPaymentState(bookings);
    return res.json(data);
  } catch (err) {
    console.error("Get host bookings error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getHostBookingsByExperience = async (req, res) => {
  try {
    const experienceId = req.params.experienceId;
    const bookings = await Booking.find({ host: req.user.id, experience: experienceId })
      .populate("experience", "title price startsAt endsAt startDate endDate activityType remainingSpots maxParticipants")
      .populate("explorer", "name email displayName profilePhoto avatar phone");
    const data = await hydrateBookingsWithPaymentState(bookings);
    return res.json(data);
  } catch (err) {
    console.error("Get host bookings by experience error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const cancelBookingByHost = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await Booking.findById(id).populate(
      "experience",
      "title host maxParticipants remainingSpots activityType status isActive"
    );
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.host.toString() !== req.user.id) return res.status(403).json({ message: "Forbidden" });
    if (isDisputeLocked(booking)) return res.status(409).json({ message: "Booking is disputed" });
    if (["CANCELLED", "REFUNDED"].includes(booking.status)) {
      return res.status(400).json({ message: "Booking already cancelled" });
    }
    if (["COMPLETED", "AUTO_COMPLETED", "NO_SHOW"].includes(booking.status)) {
      return res.status(400).json({ message: "Booking already finalized" });
    }

    // Refund if payment exists
    if (["PAID", "DEPOSIT_PAID", "CONFIRMED"].includes(booking.status)) {
      const payment = await Payment.findOne({ booking: booking._id, status: { $in: ["CONFIRMED", "INITIATED"] } });
      if (payment) {
        try {
          await refundPaymentRecord({
            payment,
            bookingId: booking._id,
            idempotencyKeyBase: "host_cancel_refund",
          });
        } catch (err) {
          console.error("Refund failed", err?.message || err);
        }
      }
    }

    booking.status = "CANCELLED";
    booking.cancelledAt = new Date();
    booking.payoutEligibleAt = null;
    await booking.save();

    const exp = booking.experience;
    if (exp) {
      const qty = booking.quantity || 1;
      const total = exp.maxParticipants || qty;
      const currentRemaining = Number.isFinite(exp.remainingSpots) ? exp.remainingSpots : Math.max(0, total - qty);
      exp.remainingSpots = Math.min(total, currentRemaining + qty);
      if (exp.remainingSpots > 0) {
        exp.soldOut = false;
      }
      await exp.save();
    }

    try {
      await createNotification({
        user: booking.explorer,
        type: "BOOKING_CANCELLED",
        title: "Booking cancelled",
        message: `Your booking for "${exp?.title || "experience"}" was cancelled by the host.`,
        data: { activityId: exp?._id || booking.experience, bookingId: booking._id, activityTitle: exp?.title },
        push: true,
      });
    } catch (err) {
      console.error("Notify cancel booking error", err);
    }

    try {
      const explorer = await User.findById(booking.explorer).select("email name displayName");
      if (explorer?.email && exp) {
        const appUrl = process.env.FRONTEND_URL || "https://www.livadai.com";
        const exploreUrl = `${appUrl.replace(/\/$/, "")}/my-activities`;
        const dateLabel = formatExperienceDate(exp);
        const html = buildBookingCancelledEmail({
          experience: exp,
          bookingId: booking._id,
          ctaUrl: exploreUrl,
          role: "explorer",
        });
        await sendEmail({
          to: explorer.email,
          subject: `Rezervare anulată: ${exp?.title || "LIVADAI"} – ${dateLabel} (#${booking._id})`,
          html,
          type: "booking_cancelled",
          userId: explorer._id,
        });
      }
    } catch (err) {
      console.error("Cancel booking email error", err);
    }

    return res.json({ success: true, status: booking.status });
  } catch (err) {
    console.error("Cancel booking by host error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const disputeBooking = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason, comment } = req.body;
    if (!["NO_SHOW", "LOW_QUALITY", "SAFETY", "OTHER"].includes(reason)) {
      return res.status(400).json({ message: "Invalid reason" });
    }
    if (comment && comment.length > 300) return res.status(400).json({ message: "Comment too long" });

    const booking = await Booking.findById(id).populate(
      "experience",
      "host startDate endDate startsAt endsAt title"
    );
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.explorer.toString() !== req.user.id) return res.status(403).json({ message: "Forbidden" });
    if (isDisputeLocked(booking)) return res.status(409).json({ message: "Already disputed" });
    if (["CANCELLED"].includes(booking.status))
      return res.status(400).json({ message: "Cannot dispute cancelled booking" });

    const start =
      booking.experience?.startsAt || booking.experience?.startDate || booking.date || booking.experience?.endDate || booking.experience?.endsAt;
    const end =
      booking.experience?.endsAt || booking.experience?.endDate || booking.date || booking.experience?.startDate || booking.experience?.startsAt;
    const endDate = end ? new Date(end) : null;
    const now = new Date();
    if (!endDate) return res.status(400).json({ message: "Experience date missing" });
    const windowStart = new Date(endDate.getTime() + 15 * 60 * 1000);
    const windowEnd = new Date(endDate.getTime() + 72 * 60 * 60 * 1000);
    if (now < windowStart || now > windowEnd) {
      return res.status(400).json({ message: "Report window closed" });
    }

    booking.status = "DISPUTED";
    booking.disputedAt = now;
    booking.disputeReason = reason;
    booking.disputeComment = comment || null;
    booking.disputeResolvedAt = null;
    await booking.save();

    try {
      await Payment.findOneAndUpdate(
        { booking: booking._id },
        { status: "DISPUTED" },
        { new: true }
      );
    } catch (err) {
      console.error("Update payment disputed error", err);
    }

    // Create report entry
    const report = await Report.create({
      type: "BOOKING_DISPUTE",
      experience: booking.experience?._id || booking.experience,
      booking: booking._id,
      host: booking.host,
      reporter: req.user?.id,
      targetType: "USER",
      targetUserId: booking.host,
      reason,
      comment,
      affectsPayout: true,
      deadlineAt: new Date(now.getTime() + 48 * 60 * 60 * 1000),
    });

    // Send email to moderators with action links
    try {
      const hostUser = await User.findById(booking.host);
      const explorerUser = await User.findById(booking.explorer);
      const experience = await Experience.findById(booking.experience);
      await sendDisputeEmail({
        booking,
        experience,
        host: hostUser,
        explorer: explorerUser,
        reason,
        comment,
        reportsEmail: process.env.REPORTS_EMAIL,
        reportId: report._id,
      });
    } catch (err) {
      console.error("Dispute email error", err);
    }

    try {
      await createNotification({
        user: booking.host,
        type: "BOOKING_DISPUTED",
        title: "Booking disputed",
        message:
          "O experiență a fost raportată. Plata este temporar blocată până la clarificarea situației. / An experience has been reported. The payout is temporarily blocked while the issue is reviewed.",
        data: { bookingId: booking._id, activityId: booking.experience?._id || booking.experience },
      });
    } catch (err) {
      console.error("Notify dispute error", err);
    }
    try {
      const hostUser = await User.findById(booking.host).select("email");
      const experience = await Experience.findById(booking.experience);
      if (hostUser?.email) {
        const dateLabel = formatExperienceDate(experience);
        const html = buildDisputeOpenedEmail({
          experience,
          bookingId: booking._id,
        });
        await sendEmail({
          to: hostUser.email,
          subject: `Dispută deschisă: ${experience?.title || "LIVADAI"} – ${dateLabel} (#${booking._id})`,
          html,
          type: "official",
          userId: hostUser._id,
        });
      }
    } catch (err) {
      console.error("Dispute host email error", err);
    }

    return res.json({ success: true, status: booking.status });
  } catch (err) {
    console.error("disputeBooking error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Content report without booking (type 1)
const reportContent = async (req, res) => {
  try {
    const { experienceId, reason, comment } = req.body;
    if (!experienceId || !reason) return res.status(400).json({ message: "experienceId and reason are required" });
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    const experience = await Experience.findById(experienceId).populate("host");
    if (!experience) return res.status(404).json({ message: "Experience not found" });

    // create report entry
    const report = await Report.create({
      type: "CONTENT",
      experience: experienceId,
      host: experience.host?._id || experience.host,
      reporter: req.user?.id,
      targetType: "EXPERIENCE",
      targetUserId: experience.host?._id || experience.host,
      reason,
      comment,
      affectsPayout: false,
      deadlineAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    });

    const reportsEmail = process.env.REPORTS_EMAIL;
    if (!reportsEmail) {
      console.warn("[REPORT_CONTENT] REPORTS_EMAIL missing; skipping email");
    } else {
      try {
        console.log("[REPORT_CONTENT] reportsEmail=", reportsEmail);
        const reporter = await User.findById(req.user?.id);
        await sendContentReportEmail({ experience, reporter, reason, comment, reportsEmail, reportId: report._id });
        console.log("[REPORT_CONTENT] email dispatched for experience", experienceId);
      } catch (err) {
        console.error("sendContentReportEmail error", err);
      }
    }

    return res.json({ success: true, message: "Report received" });
  } catch (err) {
    console.error("reportContent error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Report explorer/user directly from profile
const reportUser = async (req, res) => {
  try {
    const { targetUserId, reason, comment } = req.body || {};
    if (!targetUserId || !reason) return res.status(400).json({ message: "targetUserId and reason required" });
    if (!req.user) return res.status(401).json({ message: "Authentication required" });

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) return res.status(404).json({ message: "User not found" });

    const report = await Report.create({
      type: "USER",
      targetType: "USER",
      targetUserId,
      reporter: req.user?.id,
      reason,
      comment,
      affectsPayout: false,
      deadlineAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });

    const reportsEmail = process.env.REPORTS_EMAIL;
    if (reportsEmail) {
      try {
        const reporter = await User.findById(req.user?.id);
        await sendUserReportEmail({ targetUser, reporter, reason, comment, reportsEmail, reportId: report._id });
      } catch (err) {
        console.error("sendUserReportEmail error", err);
      }
    }

    return res.json({ success: true, message: "Report received" });
  } catch (err) {
    console.error("reportUser error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createBooking,
  getMyBookings,
  getHostBookings,
  getHostBookingsByExperience,
  cancelBookingByHost,
  disputeBooking,
  reportContent,
  reportUser,
};
