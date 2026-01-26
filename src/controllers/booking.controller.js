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
const { buildDisputeOpenedEmail, buildBookingCancelledEmail } = require("../utils/emailTemplates");
const { isPayoutEligible, logPayoutAttempt } = require("../utils/payout");
const { sendContentReportEmail, sendDisputeEmail, sendUserReportEmail } = require("../utils/reports");
const { recalcTrustedParticipant } = require("../utils/trust");

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
      return new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
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
    const bookingIds = bookings.map((b) => b._id);
    const existingReviews = await Review.find({ booking: { $in: bookingIds } }).select("booking user");
    const reviewedMap = new Set(existingReviews.map((r) => `${r.booking.toString()}::${r.user.toString()}`));
    const now = new Date();
    const data = bookings.map((b) => {
      const exp = b.experience;
      const endDate = getExperienceEndDate(exp);
      const eligible =
        b.status === "COMPLETED" &&
        endDate &&
        !Number.isNaN(endDate.getTime()) &&
        now > new Date(endDate.getTime() + 48 * 60 * 60 * 1000);
      const reviewKey = `${b._id.toString()}::${req.user.id}`;
      return {
        ...b.toObject(),
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
    return res.json(bookings);
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
    return res.json(bookings);
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
    if (["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE"].includes(booking.status)) {
      const payment = await Payment.findOne({ booking: booking._id, status: { $in: ["CONFIRMED", "INITIATED"] } });
      if (payment?.stripePaymentIntentId) {
        try {
          await stripe.refunds.create({ payment_intent: payment.stripePaymentIntentId });
          payment.status = "REFUNDED";
          await payment.save();
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
        const appUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
        const exploreUrl = `${appUrl.replace(/\/$/, "")}/my-activities`;
        const html = buildBookingCancelledEmail({
          experience: exp,
          bookingId: booking._id,
          ctaUrl: exploreUrl,
          role: "explorer",
        });
        await sendEmail({
          to: explorer.email,
          subject: "Rezervare anulată / Booking cancelled – LIVADAI",
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

const updateAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body; // CONFIRMED | NO_SHOW
    if (!["CONFIRMED", "NO_SHOW"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const booking = await Booking.findById(id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.host.toString() !== req.user.id) {
      return res.status(403).json({ message: "Forbidden" });
    }
    if (isDisputeLocked(booking)) return res.status(409).json({ message: "Booking is disputed" });

    booking.attendanceStatus = status;
    if (status === "CONFIRMED") {
      booking.status = "COMPLETED";
      booking.completedAt = new Date();
    }
    if (status === "NO_SHOW") {
      booking.status = "NO_SHOW";
      booking.completedAt = new Date();
    }
    await booking.save();
    return res.json({ success: true });
  } catch (err) {
    console.error("updateAttendance error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const confirmAttendance = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await Booking.findById(id).populate("experience", "host startDate endDate startsAt endsAt title");
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.host.toString() !== req.user.id) return res.status(403).json({ message: "Forbidden" });
    if (isDisputeLocked(booking)) return res.status(409).json({ message: "Booking is disputed" });

    const start =
      booking.experience?.startsAt || booking.experience?.startDate || booking.date || booking.experience?.endDate || booking.experience?.endsAt;
    const end = booking.experience?.endsAt || booking.experience?.endDate || booking.date || booking.experience?.startDate || booking.experience?.startsAt;
    const startDate = start ? new Date(start) : null;
    const endDate = end ? new Date(end) : null;
    const windowStart = startDate ? new Date(startDate.getTime() + 15 * 60 * 1000) : null;
    const windowEnd = endDate ? new Date(endDate.getTime() + 48 * 60 * 60 * 1000) : null;
    const now = new Date();
    if (!windowStart || !windowEnd || now < windowStart || now > windowEnd) {
      return res.status(400).json({
        message: "Attendance can be confirmed after start time and up to 48h after the event ends.",
      });
    }

    if (booking.status === "COMPLETED") {
      return res.json({ success: true, status: booking.status });
    }

    const nowTime = new Date();
    booking.status = "COMPLETED";
    booking.attendanceStatus = "CONFIRMED";
    booking.attendanceConfirmed = true;
    booking.completedAt = nowTime;
    booking.payoutEligibleAt = new Date(nowTime.getTime() + 72 * 60 * 60 * 1000);
    await booking.save();

    try {
      await createNotification({
        user: booking.explorer,
        type: "BOOKING_CONFIRMED",
        title: "Booking confirmed",
        message: `Your booking for "${booking.experience?.title || "experience"}" is confirmed.`,
        data: {
          activityId: booking.experience?._id || booking.experience,
          bookingId: booking._id,
          activityTitle: booking.experience?.title,
        },
      });
    } catch (err) {
      console.error("Notify confirm booking error", err);
    }
    try {
      await recalcTrustedParticipant(booking.explorer);
    } catch (err) {
      console.error("recalcTrustedParticipant error", err);
    }

    return res.json({ success: true, status: booking.status });
  } catch (err) {
    console.error("confirmAttendance error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const markNoShow = async (req, res) => {
  try {
    const { id } = req.params;
    const booking = await Booking.findById(id).populate("experience", "host startDate endDate startsAt endsAt title");
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (booking.host.toString() !== req.user.id) return res.status(403).json({ message: "Forbidden" });
    if (isDisputeLocked(booking)) return res.status(409).json({ message: "Booking is disputed" });

    const start =
      booking.experience?.startsAt || booking.experience?.startDate || booking.date || booking.experience?.endDate || booking.experience?.endsAt;
    const end = booking.experience?.endsAt || booking.experience?.endDate || booking.date || booking.experience?.startDate || booking.experience?.startsAt;
    const startDate = start ? new Date(start) : null;
    const endDate = end ? new Date(end) : null;
    const windowStart = startDate ? new Date(startDate.getTime() + 15 * 60 * 1000) : null;
    const windowEnd = endDate ? new Date(endDate.getTime() + 48 * 60 * 60 * 1000) : null;
    const now = new Date();
    if (!windowStart || !windowEnd || now < windowStart || now > windowEnd) {
      return res.status(400).json({
        message: "Attendance can be confirmed after start time and up to 48h after the event ends.",
      });
    }

    if (booking.status === "NO_SHOW") {
      return res.json({ success: true, status: booking.status });
    }

    const nowTime = new Date();
    booking.status = "NO_SHOW";
    booking.attendanceStatus = "NO_SHOW";
    booking.attendanceConfirmed = true;
    booking.completedAt = nowTime;
    booking.payoutEligibleAt = null;
    await booking.save();

    return res.json({ success: true, status: booking.status });
  } catch (err) {
    console.error("markNoShow error", err);
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
        message: `Booking for "${booking.experience?.title || "experience"}" was disputed. Payout is paused.`,
        data: { bookingId: booking._id, activityId: booking.experience?._id || booking.experience },
      });
    } catch (err) {
      console.error("Notify dispute error", err);
    }
    try {
      const hostUser = await User.findById(booking.host).select("email");
      const experience = await Experience.findById(booking.experience);
      if (hostUser?.email) {
        const html = buildDisputeOpenedEmail({
          experience,
          bookingId: booking._id,
        });
        await sendEmail({
          to: hostUser.email,
          subject: "Dispută deschisă / Dispute opened – LIVADAI",
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
  updateAttendance,
  confirmAttendance,
  markNoShow,
  disputeBooking,
  reportContent,
  reportUser,
};
