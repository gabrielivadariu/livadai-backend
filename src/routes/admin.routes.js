const { Router } = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const Report = require("../models/report.model");
const Payment = require("../models/payment.model");
const stripe = require("../config/stripe");
const { createNotification } = require("../controllers/notifications.controller");
const { recalcTrustedParticipant } = require("../utils/trust");
const { sendEmail } = require("../utils/mailer");
const { buildBookingCancelledEmail } = require("../utils/emailTemplates");

const router = Router();

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
