const { Router } = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const Report = require("../models/report.model");
const Payment = require("../models/payment.model");
const MediaDeletionLog = require("../models/mediaDeletionLog.model");
const stripe = require("../config/stripe");
const { createNotification } = require("../controllers/notifications.controller");
const { recalcTrustedParticipant } = require("../utils/trust");
const { sendEmail } = require("../utils/mailer");
const { buildBookingCancelledEmail } = require("../utils/emailTemplates");
const { authenticate, authorize } = require("../middleware/auth.middleware");

const router = Router();
const cleanupActiveStatuses = ["PENDING", "PAID", "DEPOSIT_PAID", "CONFIRMED", "PENDING_ATTENDANCE", "DISPUTED"];

const hasExperienceMedia = (exp) =>
  !!(
    (Array.isArray(exp?.mediaRefs) && exp.mediaRefs.length) ||
    (Array.isArray(exp?.images) && exp.images.length) ||
    (Array.isArray(exp?.videos) && exp.videos.length) ||
    exp?.mainImageUrl ||
    exp?.coverImageUrl
  );

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

const getCleanupEligibleAt = (exp) => {
  if (!exp) return null;
  if (String(exp.status || "").toUpperCase() === "NO_BOOKINGS") {
    return getExperienceEndDate(exp);
  }
  if (String(exp.status || "").toUpperCase() === "CANCELLED") {
    const updatedAt = exp.updatedAt ? new Date(exp.updatedAt) : null;
    if (updatedAt && !Number.isNaN(updatedAt.getTime())) return updatedAt;
  }
  return getExperienceEndDate(exp);
};

const verifyToken = (token) => {
  const secret = process.env.ADMIN_ACTION_SECRET || "admin-secret";
  return jwt.verify(token, secret);
};

const logAction = (action, bookingId) => {
  console.log(`[ADMIN_ACTION] ${new Date().toISOString()} action=${action} booking=${bookingId || "n/a"}`);
};

const refundBooking = async (booking, reason = "Admin action") => {
  try {
    const payment = await Payment.findOne({ booking: booking._id, status: { $in: ["CONFIRMED", "INITIATED"] } });
    if (payment?.stripePaymentIntentId) {
      await stripe.refunds.create({ payment_intent: payment.stripePaymentIntentId });
      payment.status = "REFUNDED";
      await payment.save();
    }
    booking.status = "REFUNDED";
    booking.refundedAt = new Date();
    booking.payoutEligibleAt = null;
    await booking.save();
    try {
      await createNotification({
        user: booking.explorer,
        type: "BOOKING_CANCELLED",
        title: "Booking refunded",
        message: `Booking was refunded: ${reason}.`,
        data: { bookingId: booking._id, activityId: booking.experience },
        push: true,
      });
    } catch (err) {
      console.error("notify refund error", err);
    }
  } catch (err) {
    console.error("Refund booking error", err);
  }
};

const applyResolve = async (bookingId) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) return "Booking not found";
  booking.status = "COMPLETED";
  booking.disputedAt = null;
  booking.disputeReason = null;
  booking.disputeComment = null;
  if (!booking.disputeResolvedAt) {
    booking.disputeResolvedAt = new Date();
  }
  const base = booking.completedAt || new Date();
  booking.completedAt = base;
  booking.payoutEligibleAt = new Date(base.getTime() + 72 * 60 * 60 * 1000);
  await booking.save();
  return "Booking marked resolved";
};

const applyIgnore = async (bookingId) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) return "Booking not found";
  booking.disputedAt = null;
  booking.disputeReason = null;
  booking.disputeComment = null;
  if (!booking.disputeResolvedAt) {
    booking.disputeResolvedAt = new Date();
  }
  if (booking.status === "DISPUTED") booking.status = "COMPLETED";
  if (booking.completedAt) {
    booking.payoutEligibleAt = new Date(booking.completedAt.getTime() + 72 * 60 * 60 * 1000);
  }
  await booking.save();
  return "Booking dispute ignored";
};

const applyRefundExplorer = async (bookingId) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) return "Booking not found";
  booking.status = "CANCELLED";
  booking.cancelledAt = new Date();
  booking.payoutEligibleAt = null;
  if (!booking.disputeResolvedAt) {
    booking.disputeResolvedAt = new Date();
  }
  await booking.save();
  return "Booking marked for refund/cancelled";
};

const applyBanExplorer = async (explorerId) => {
  const user = await User.findById(explorerId);
  if (!user) return "Explorer not found";
  user.isBlocked = true;
  user.isBanned = true;
  await user.save();
  return "Explorer banned";
};

const applyDisableExperience = async (experienceId) => {
  const exp = await Experience.findById(experienceId);
  if (!exp) return "Experience not found";
  exp.isActive = false;
  exp.status = "DISABLED";
  exp.soldOut = true;
  exp.remainingSpots = 0;
  await exp.save();
  const bookings = await Booking.find({
    experience: experienceId,
    status: { $in: ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE"] },
  }).populate("explorer", "email name displayName");
  const hostUser = await User.findById(exp.host).select("email name displayName");
  const appUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
  const exploreUrl = `${appUrl.replace(/\/$/, "")}/experiences`;
  for (const b of bookings) {
    await refundBooking(b, "Experience disabled by admin");
    try {
      if (b.explorer?.email) {
        const html = buildBookingCancelledEmail({
          experience: exp,
          bookingId: b._id,
          ctaUrl: exploreUrl,
          role: "explorer",
        });
        await sendEmail({
          to: b.explorer.email,
          subject: `Experiență anulată: ${exp?.title || "LIVADAI"} (#${b._id})`,
          html,
          type: "booking_cancelled",
          userId: b.explorer._id,
        });
      }
    } catch (err) {
      console.error("Disable experience email error", err);
    }
  }
  try {
    if (hostUser?.email) {
      const html = buildBookingCancelledEmail({
        experience: exp,
        ctaUrl: exploreUrl,
        role: "host",
      });
      await sendEmail({
        to: hostUser.email,
        subject: `Experiență anulată: ${exp?.title || "LIVADAI"} (host)`,
        html,
        type: "booking_cancelled",
        userId: hostUser._id,
      });
    }
  } catch (err) {
    console.error("Disable experience host email error", err);
  }
  await Booking.updateMany(
    { experience: experienceId, status: { $in: ["PENDING", "CANCELLED", "REFUNDED"] } },
    { payoutEligibleAt: null }
  );
  return "Experience disabled; bookings refunded/cancelled";
};

const applyBanHost = async (hostId) => {
  const host = await User.findById(hostId);
  if (!host) return "Host not found";
  host.isBlocked = true;
  host.isBanned = true;
  await host.save();
  await Experience.updateMany({ host: hostId }, { isActive: false, status: "DISABLED", soldOut: true, remainingSpots: 0 });
  const bookings = await Booking.find({
    host: hostId,
    status: { $in: ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE"] },
  });
  for (const b of bookings) {
    await refundBooking(b, "Host banned by admin");
  }
  await Booking.updateMany(
    { host: hostId, status: { $nin: ["REFUNDED", "CANCELLED"] } },
    { payoutEligibleAt: null }
  );
  return "Host blocked, experiences disabled, bookings refunded";
};

const handleAction = async (req, res) => {
  try {
    const { action, bookingId, hostId, experienceId, explorerId, reportId, token, confirm, confirmText } = {
      ...req.query,
      ...req.body,
    };
    if (!token) return res.status(401).send("Missing token");
    let payload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      return res.status(401).send("Invalid or expired token");
    }
    // optional: validate reportId matches token payload if present
    if (payload?.reportId && reportId && payload.reportId !== reportId) {
      return res.status(401).send("Token/report mismatch");
    }

    if (
      ![
        "BAN_HOST",
        "DISABLE_EXPERIENCE",
        "RESOLVE",
        "IGNORE",
        "REFUND_EXPLORER",
        "BAN_EXPLORER",
        "RESOLVE_PAYOUT",
        "IGNORE_REPORT",
      ].includes(action)
    ) {
      return res.status(400).send("Invalid action");
    }

    const criticalActions = ["BAN_HOST", "BAN_EXPLORER", "DISABLE_EXPERIENCE"];
    const needsText = criticalActions.includes(action);
    const requiredWord = action === "DISABLE_EXPERIENCE" ? "DISABLE" : "BAN";
    if (!confirm) {
      return res.status(400).send("Confirmation checkbox required");
    }
    if (needsText && (!confirmText || confirmText.trim().toUpperCase() !== requiredWord)) {
      return res.status(400).send(`Type ${requiredWord} to confirm this action`);
    }

    let message = "OK";
    if (action === "BAN_HOST") message = await applyBanHost(hostId);
    if (action === "DISABLE_EXPERIENCE") message = await applyDisableExperience(experienceId);
    if (action === "RESOLVE" || action === "RESOLVE_PAYOUT") message = await applyResolve(bookingId);
    if (action === "IGNORE" || action === "IGNORE_REPORT") message = await applyIgnore(bookingId);
    if (action === "REFUND_EXPLORER") message = await applyRefundExplorer(bookingId);
    if (action === "BAN_EXPLORER") message = await applyBanExplorer(explorerId);

    if (reportId) {
      const report = await Report.findByIdAndUpdate(
        reportId,
        {
          status: action === "IGNORE" || action === "IGNORE_REPORT" ? "IGNORED" : "HANDLED",
          handledAt: new Date(),
          handledBy: "admin-email-action",
          actionTaken: action,
        },
        { new: true }
      );
      if (report?.targetUserId) {
        try {
          await recalcTrustedParticipant(report.targetUserId);
        } catch (err) {
          console.error("recalcTrustedParticipant (admin) error", err);
        }
      }
    }

    logAction(action, bookingId);
    return res.send(message);
  } catch (err) {
    console.error("Admin action error", err);
    return res.status(500).send("Server error");
  }
};

// confirmation + execution split: GET renders confirm page, POST executes
router.get("/report-action", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(401).send("Missing token");
    let payload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      return res.status(401).send("Invalid or expired token");
    }
    const { action, bookingId, hostId, explorerId, experienceId, reportId } = { ...payload, ...req.query };
    const needsText = ["BAN_HOST", "BAN_EXPLORER", "DISABLE_EXPERIENCE"].includes(action);
    const requiredWord = action === "DISABLE_EXPERIENCE" ? "DISABLE" : "BAN";
    const confirmLabel =
      action === "DISABLE_EXPERIENCE"
        ? "You are about to DISABLE this experience. This action is irreversible."
        : action === "BAN_HOST"
          ? "You are about to BAN this host. All their experiences will be disabled."
          : action === "BAN_EXPLORER"
            ? "You are about to BAN this explorer. They will no longer be able to book."
            : "This action will update the report.";
    const title =
      action === "DISABLE_EXPERIENCE"
        ? "Disable Experience"
        : action === "BAN_HOST"
          ? "Ban Host"
          : action === "BAN_EXPLORER"
            ? "Ban Explorer"
            : action === "IGNORE" || action === "IGNORE_REPORT"
              ? "Ignore Report"
              : "Admin action";
    const warning =
      action === "IGNORE" || action === "IGNORE_REPORT"
        ? "This will mark the report as ignored."
        : "This action is irreversible and affects real users/bookings.";

    const html = `
      <h2>${title}</h2>
      <p>${warning}</p>
      <form method="POST" action="/admin/report-action">
        <input type="hidden" name="token" value="${token}" />
        <input type="hidden" name="action" value="${action}" />
        ${bookingId ? `<input type="hidden" name="bookingId" value="${bookingId}" />` : ""}
        ${hostId ? `<input type="hidden" name="hostId" value="${hostId}" />` : ""}
        ${explorerId ? `<input type="hidden" name="explorerId" value="${explorerId}" />` : ""}
        ${experienceId ? `<input type="hidden" name="experienceId" value="${experienceId}" />` : ""}
        ${reportId ? `<input type="hidden" name="reportId" value="${reportId}" />` : ""}
        <p>${confirmLabel}</p>
        <p><label><input type="checkbox" name="confirm" /> I understand this action is irreversible and affects real users.</label></p>
        ${
          needsText
            ? `<p>Type <strong>${requiredWord}</strong> to confirm: <input name="confirmText" /></p>`
            : ""
        }
        <button type="submit">Confirm</button>
      </form>
    `;
    return res.send(html);
  } catch (err) {
    console.error("Admin GET action error", err);
    return res.status(500).send("Server error");
  }
});

router.post("/report-action", handleAction);

router.get("/media/stats", authenticate, authorize(["ADMIN"]), async (_req, res) => {
  try {
    const now = new Date();
    const retentionHours = Number(process.env.MEDIA_RETENTION_HOURS || 72);
    const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const experiences = await Experience.find({
      $or: [
        { "mediaRefs.0": { $exists: true } },
        { "images.0": { $exists: true } },
        { "videos.0": { $exists: true } },
        { mainImageUrl: { $exists: true, $nin: ["", null] } },
        { coverImageUrl: { $exists: true, $nin: ["", null] } },
      ],
    })
      .select("isActive status endsAt endDate startsAt startDate durationMinutes updatedAt mediaRefs images videos mainImageUrl coverImageUrl mediaCleanedAt")
      .lean();

    const withMedia = experiences.filter((exp) => hasExperienceMedia(exp));
    const activeWithMedia = withMedia.filter((exp) => exp.isActive !== false);
    const inactiveWithMedia = withMedia.filter((exp) => exp.isActive === false);
    const cleanedWithMedia = withMedia.filter((exp) => !!exp.mediaCleanedAt);
    const pendingCleanup = withMedia.filter((exp) => !exp.mediaCleanedAt);

    const cleanupCandidates = pendingCleanup.filter((exp) => {
      const eligibleAt = getCleanupEligibleAt(exp);
      return !!eligibleAt && eligibleAt <= cutoff;
    });

    let activeBookingSet = new Set();
    if (cleanupCandidates.length) {
      const candidateIds = cleanupCandidates.map((exp) => exp._id);
      const activeBookingRows = await Booking.aggregate([
        {
          $match: {
            experience: { $in: candidateIds },
            status: { $in: cleanupActiveStatuses },
          },
        },
        { $group: { _id: "$experience" } },
      ]);
      activeBookingSet = new Set(activeBookingRows.map((row) => String(row._id)));
    }

    const orphanCandidates = cleanupCandidates.filter((exp) => !activeBookingSet.has(String(exp._id)));
    const blockedByActiveBookings = cleanupCandidates.length - orphanCandidates.length;

    const usersWithAvatar = await User.countDocuments({
      $or: [
        { avatarPublicId: { $exists: true, $nin: ["", null] } },
        { avatar: { $exists: true, $nin: ["", null] } },
      ],
    });

    const [deleted24hRows, deleted24hByScope] = await Promise.all([
      MediaDeletionLog.aggregate([
        { $match: { createdAt: { $gte: since24h } } },
        {
          $group: {
            _id: null,
            events: { $sum: 1 },
            requestedCount: { $sum: "$requestedCount" },
            deletedCount: { $sum: "$deletedCount" },
          },
        },
      ]),
      MediaDeletionLog.aggregate([
        { $match: { createdAt: { $gte: since24h } } },
        {
          $group: {
            _id: "$scope",
            events: { $sum: 1 },
            deletedCount: { $sum: "$deletedCount" },
          },
        },
        { $sort: { deletedCount: -1, events: -1 } },
      ]),
    ]);

    const deleted24h = deleted24hRows[0] || {
      events: 0,
      requestedCount: 0,
      deletedCount: 0,
    };

    return res.json({
      generatedAt: now.toISOString(),
      retentionHours,
      cutoff: cutoff.toISOString(),
      summary: {
        experiencesWithMedia: withMedia.length,
        activeExperiencesWithMedia: activeWithMedia.length,
        inactiveExperiencesWithMedia: inactiveWithMedia.length,
        cleanedExperiencesWithMedia: cleanedWithMedia.length,
        pendingCleanupExperiences: pendingCleanup.length,
        cleanupCandidates: cleanupCandidates.length,
        orphanCandidates: orphanCandidates.length,
        blockedByActiveBookings,
        usersWithAvatar,
      },
      deletedLast24h: {
        events: deleted24h.events || 0,
        requestedCount: deleted24h.requestedCount || 0,
        deletedCount: deleted24h.deletedCount || 0,
      },
      deletedLast24hByScope: deleted24hByScope.map((row) => ({
        scope: row._id || "unknown",
        events: row.events || 0,
        deletedCount: row.deletedCount || 0,
      })),
      orphanCandidateSample: orphanCandidates.slice(0, 20).map((exp) => ({
        id: String(exp._id),
        status: exp.status,
        isActive: exp.isActive,
        eligibleAt: getCleanupEligibleAt(exp)?.toISOString?.() || null,
        updatedAt: exp.updatedAt?.toISOString?.() || null,
      })),
    });
  } catch (err) {
    console.error("Admin media stats error", err);
    return res.status(500).json({ message: "Failed to build media stats" });
  }
});

// simple preview page for reports (token-protected)
router.get("/report/:id/preview", async (req, res) => {
  try {
    const { token } = req.query;
    const { id } = req.params;
    if (!token) return res.status(401).send("Missing token");
    try {
      verifyToken(token);
    } catch (err) {
      return res.status(401).send("Invalid or expired token");
    }
    const report = await Report.findById(id).populate("experience").populate("host").populate("reporter");
    if (!report) return res.status(404).send("Report not found");
    const exp = report.experience || {};
    const host = report.host || {};
    const reporter = report.reporter || {};
    const actionsHtml = `
      <p><strong>Actions:</strong></p>
      <ul>
        <li><a href="${req.protocol}://${req.get("host")}/admin/report-action?action=DISABLE_EXPERIENCE&experienceId=${exp._id}&reportId=${report._id}&token=${encodeURIComponent(token)}">Disable Experience</a></li>
        <li><a href="${req.protocol}://${req.get("host")}/admin/report-action?action=BAN_HOST&hostId=${host._id}&reportId=${report._id}&token=${encodeURIComponent(token)}">Ban Host</a></li>
        ${reporter?._id ? `<li><a href="${req.protocol}://${req.get("host")}/admin/report-action?action=BAN_EXPLORER&explorerId=${reporter._id}&reportId=${report._id}&token=${encodeURIComponent(token)}">Ban Explorer</a></li>` : ""}
        <li><a href="${req.protocol}://${req.get("host")}/admin/report-action?action=IGNORE_REPORT&reportId=${report._id}&token=${encodeURIComponent(token)}">Ignore</a></li>
      </ul>
    `;
    const html = `
      <h2>Report preview (${report.type})</h2>
      <p><strong>Status:</strong> ${report.status}</p>
      <h3>Experience</h3>
      <p>${exp.title || ""} (${exp._id || ""})</p>
      <p>${exp.address || ""}</p>
      <p>Status: ${exp.isActive === false ? "DISABLED" : "ACTIVE"}</p>
      ${exp.description ? `<p><strong>About the experience:</strong><br/>${exp.description}</p>` : ""}
      ${exp.images?.length ? `<p>Images:</p>${exp.images.map((i) => `<img src="${i}" width="120" />`).join("")}` : ""}
      <h3>Host</h3>
      <p>${host.name || host.displayName || ""} (${host._id || ""})</p>
      <p>Email: ${host.email || ""}</p>
      <p>Phone: ${host.phone || host.phoneNumber || ""}</p>
      <h3>Reporter</h3>
      <p>${reporter.name || reporter.displayName || reporter._id || "anonymous"}</p>
      <p>Email: ${reporter.email || ""}</p>
      <p>Phone: ${reporter.phone || reporter.phoneNumber || ""}</p>
      <h3>Details</h3>
      <p>Reason: ${report.reason || ""}</p>
      <p>Comment: ${report.comment || ""}</p>
      ${actionsHtml}
    `;
    res.send(html);
  } catch (err) {
    console.error("Report preview error", err);
    res.status(500).send("Server error");
  }
});

module.exports = router;
