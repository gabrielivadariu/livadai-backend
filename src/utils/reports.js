const jwt = require("jsonwebtoken");
const { sendEmail } = require("./mailer");
const Booking = require("../models/booking.model");
const Message = require("../models/message.model");

const buildActionLink = ({ action, bookingId, experienceId, hostId, explorerId, reportId }) => {
  const secret = process.env.ADMIN_ACTION_SECRET || "admin-secret";
  const token = jwt.sign(
    { action, bookingId, experienceId, hostId, explorerId, reportId },
    secret,
    { expiresIn: "48h" }
  );
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:4000";
  return `${base}/admin/report-action?action=${encodeURIComponent(action)}&token=${encodeURIComponent(token)}`;
};

const buildPreviewLink = ({ reportId }) => {
  if (!reportId) return "";
  const secret = process.env.ADMIN_ACTION_SECRET || "admin-secret";
  const token = jwt.sign({ reportId }, secret, { expiresIn: "48h" });
  const base = process.env.PUBLIC_BASE_URL || "http://localhost:4000";
  return `${base}/admin/report/${reportId}/preview?token=${encodeURIComponent(token)}`;
};

const sendContentReportEmail = async ({ experience, reporter, reason, comment, reportsEmail, reportId }) => {
  if (!reportsEmail) {
    console.warn("[REPORT_CONTENT] REPORTS_EMAIL missing; skipping email");
    return;
  }
  const host = experience?.host || {};
  const reporterUser = reporter || {};
  const subject = `[LIVADAI] Content report for "${experience?.title || "experience"}"`;
  const disableLink = buildActionLink({ action: "DISABLE_EXPERIENCE", experienceId: experience?._id, hostId: host?._id, reportId });
  const banHostLink = buildActionLink({ action: "BAN_HOST", hostId: host?._id, reportId });
  const banExplorerLink = reporterUser?._id ? buildActionLink({ action: "BAN_EXPLORER", explorerId: reporterUser._id, reportId }) : null;
  const ignoreLink = buildActionLink({ action: "IGNORE_REPORT", reportId });
  const previewLink = buildPreviewLink({ reportId });
  const desc = experience?.description || "";
  const descShort = desc.length > 400 ? `${desc.slice(0, 400)}…` : desc;
  let totalBookings = 0;
  let activeBookings = 0;
  if (experience?._id) {
    try {
      totalBookings = await Booking.countDocuments({ experience: experience._id });
      activeBookings = await Booking.countDocuments({
        experience: experience._id,
        status: { $in: ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE", "COMPLETED", "AUTO_COMPLETED", "DISPUTED"] },
      });
    } catch (err) {
      console.error("Report booking count error", err);
    }
  }

  const html = `
    <h3>Content report</h3>
    <p><strong>Experience:</strong> ${experience?.title || ""} (${experience?._id})</p>
    <p><strong>Status:</strong> ${experience?.status || "UNKNOWN"}</p>
    <p><strong>Total bookings:</strong> ${totalBookings}</p>
    <p><strong>Active/affected bookings:</strong> ${activeBookings}</p>
    <p><strong>About the experience (summary):</strong><br/>${descShort || "N/A"}</p>
    <p><strong>Host:</strong> ${host.name || host.displayName || ""} (${host._id || ""})</p>
    <p><strong>Host phone:</strong> ${host.phone || host.phoneNumber || ""}</p>
    <p><strong>Host email:</strong> ${host.email || ""}</p>
    <p><strong>Reporter:</strong> ${reporterUser.name || reporterUser.displayName || reporterUser._id || "anonymous"} (${reporterUser._id || "anonymous"})</p>
    <p><strong>Reporter phone:</strong> ${reporterUser.phone || reporterUser.phoneNumber || ""}</p>
    <p><strong>Reporter email:</strong> ${reporterUser.email || ""}</p>
    <p><strong>Type:</strong> CONTENT REPORT</p>
    <p><strong>Reason:</strong> ${reason}</p>
    ${comment ? `<p><strong>Comment:</strong> ${comment}</p>` : ""}
    <hr/>
    <p><strong>Actions (expire in 48h):</strong></p>
    <ul>
      <li><a href="${disableLink}">Disable Experience</a></li>
      <li><a href="${banHostLink}">Ban Host</a></li>
      ${banExplorerLink ? `<li><a href="${banExplorerLink}">Ban Explorer</a></li>` : ""}
      <li><a href="${ignoreLink}">Ignore Report</a></li>
    </ul>
    ${previewLink ? `<p><a href="${previewLink}">Preview report details</a></p>` : ""}
  `;
  console.log("[REPORT_CONTENT] sending email to", reportsEmail);
  await sendEmail({
    to: reportsEmail,
    subject,
    html,
    type: "report",
  });
  console.log("[REPORT_CONTENT] sendMail finished");
};

const sendDisputeEmail = async ({ booking, experience, host, explorer, reason, comment, reportsEmail, reportId }) => {
  if (!reportsEmail) {
    console.warn("[REPORT_DISPUTE] REPORTS_EMAIL missing; skipping email");
    return;
  }
  const escapeHtml = (value) => {
    if (value === null || value === undefined) return "";
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  let conversationHtml = "";
  if (booking?._id) {
    try {
      const messages = await Message.find({ booking: booking._id })
        .sort({ createdAt: 1 })
        .limit(20)
        .populate("sender", "name displayName");

      if (messages.length) {
        const hostId = host?._id?.toString();
        const explorerId = explorer?._id?.toString();
        const rows = messages
          .map((m) => {
            const senderId = m.sender?._id?.toString() || m.sender?.toString();
            const senderName =
              m.sender?.displayName || m.sender?.name || senderId || "Unknown";
            const role = senderId === hostId ? "Host" : senderId === explorerId ? "Explorer" : "User";
            const stamp = m.createdAt ? new Date(m.createdAt).toLocaleString() : "";
            return `<li><strong>${escapeHtml(stamp)}</strong> — ${escapeHtml(role)} (${escapeHtml(senderName)}): ${escapeHtml(m.message)}</li>`;
          })
          .join("");

        conversationHtml = `
          <hr/>
          <h4>Conversation (last 20 messages)</h4>
          <ul>
            ${rows}
          </ul>
        `;
      }
    } catch (err) {
      console.error("Report dispute conversation load error", err);
    }
  }
  const refundLink = buildActionLink({ action: "REFUND_EXPLORER", bookingId: booking?._id, experienceId: experience?._id, hostId: host?._id, explorerId: explorer?._id, reportId });
  const banHostLink = buildActionLink({ action: "BAN_HOST", hostId: host?._id, reportId });
  const banExplorerLink = buildActionLink({ action: "BAN_EXPLORER", explorerId: explorer?._id, reportId });
  const resolveLink = buildActionLink({ action: "RESOLVE_PAYOUT", bookingId: booking?._id, experienceId: experience?._id, reportId });
  const ignoreLink = buildActionLink({ action: "IGNORE_REPORT", bookingId: booking?._id, reportId });
  const previewLink = buildPreviewLink({ reportId });
  const desc = experience?.description || "";
  const descShort = desc.length > 400 ? `${desc.slice(0, 400)}…` : desc;
  let totalBookings = 0;
  let activeBookings = 0;
  if (experience?._id) {
    try {
      totalBookings = await Booking.countDocuments({ experience: experience._id });
      activeBookings = await Booking.countDocuments({
        experience: experience._id,
        status: { $in: ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE", "COMPLETED", "AUTO_COMPLETED", "DISPUTED"] },
      });
    } catch (err) {
      console.error("Report booking count error", err);
    }
  }

  const html = `
    <h3>Booking disputed</h3>
    <p><strong>Experience:</strong> ${experience?.title || ""} (${experience?._id})</p>
    <p><strong>Status:</strong> ${experience?.status || "UNKNOWN"}</p>
    <p><strong>Total bookings:</strong> ${totalBookings}</p>
    <p><strong>Active/affected bookings:</strong> ${activeBookings}</p>
    <p><strong>About the experience (summary):</strong><br/>${descShort || "N/A"}</p>
    <p><strong>Host:</strong> ${host?.name || host?.displayName || ""} (${host?._id || ""})</p>
    <p><strong>Host phone:</strong> ${host?.phone || host?.phoneNumber || ""}</p>
    <p><strong>Host email:</strong> ${host?.email || ""}</p>
    <p><strong>Explorer:</strong> ${explorer?.name || explorer?.displayName || ""} (${explorer?._id || ""})</p>
    <p><strong>Explorer phone:</strong> ${explorer?.phone || explorer?.phoneNumber || ""}</p>
    <p><strong>Explorer email:</strong> ${explorer?.email || ""}</p>
    <p><strong>BookingId:</strong> ${booking?._id || ""}</p>
    <p><strong>Type:</strong> DISPUTE</p>
    <p><strong>Reason:</strong> ${reason}</p>
    ${comment ? `<p><strong>Comment:</strong> ${comment}</p>` : ""}
    ${conversationHtml}
    <hr/>
    <p><strong>Actions (expire in 48h):</strong></p>
    <ul>
      <li><a href="${refundLink}">Refund Explorer</a></li>
      <li><a href="${banHostLink}">Ban Host</a></li>
      <li><a href="${banExplorerLink}">Ban Explorer</a></li>
      <li><a href="${resolveLink}">Resolve (allow payout)</a></li>
      <li><a href="${ignoreLink}">Ignore</a></li>
    </ul>
    ${previewLink ? `<p><a href="${previewLink}">Preview report details</a></p>` : ""}
  `;
  console.log("[REPORT_DISPUTE] sending email to", reportsEmail);
  await sendEmail({
    to: reportsEmail,
    subject,
    html,
    type: "report",
  });
  console.log("[REPORT_DISPUTE] sendMail finished");
};

const sendUserReportEmail = async ({ targetUser, reporter, reason, comment, reportsEmail, reportId }) => {
  if (!reportsEmail) {
    console.warn("[REPORT_USER] REPORTS_EMAIL missing; skipping email");
    return;
  }
  const role = (targetUser?.role || "").toString().toUpperCase();
  const isHost = role === "HOST" || role === "BOTH";
  const banAction = isHost ? "BAN_HOST" : "BAN_EXPLORER";
  const banTargetLink = buildActionLink({
    action: banAction,
    hostId: isHost ? targetUser?._id : undefined,
    explorerId: !isHost ? targetUser?._id : undefined,
    reportId,
  });
  const ignoreLink = buildActionLink({ action: "IGNORE_REPORT", reportId });
  const previewLink = buildPreviewLink({ reportId });

  const html = `
    <h3>User report</h3>
    <p><strong>Target user:</strong> ${targetUser?.name || targetUser?.displayName || ""} (${targetUser?._id || ""})</p>
    <p><strong>Target phone:</strong> ${targetUser?.phone || ""}</p>
    <p><strong>Target email:</strong> ${targetUser?.email || ""}</p>
    <p><strong>Reporter:</strong> ${reporter?.name || reporter?.displayName || reporter?._id || "anonymous"} (${reporter?._id || "anonymous"})</p>
    <p><strong>Reporter phone:</strong> ${reporter?.phone || ""}</p>
    <p><strong>Reporter email:</strong> ${reporter?.email || ""}</p>
    <p><strong>Type:</strong> USER REPORT</p>
    <p><strong>Reason:</strong> ${reason}</p>
    ${comment ? `<p><strong>Comment:</strong> ${comment}</p>` : ""}
    <hr/>
    <p><strong>Actions (expire in 48h):</strong></p>
    <ul>
      <li><a href="${banTargetLink}">${isHost ? "Ban Host" : "Ban Explorer"}</a></li>
      <li><a href="${ignoreLink}">Ignore Report</a></li>
    </ul>
    ${previewLink ? `<p><a href="${previewLink}">Preview report details</a></p>` : ""}
  `;
  console.log("[REPORT_USER] sending email to", reportsEmail);
  await sendEmail({
    to: reportsEmail,
    subject: `[LIVADAI] User report: ${targetUser?.name || targetUser?._id}`,
    html,
    type: "report",
  });
  console.log("[REPORT_USER] sendMail finished");
};

module.exports = { sendContentReportEmail, sendDisputeEmail, sendUserReportEmail, buildActionLink, buildPreviewLink };
