const { Router } = require("express");
const jwt = require("jsonwebtoken");
const { sendMail } = require("../utils/mailer");
const Experience = require("../models/experience.model");
const User = require("../models/user.model");
const { authenticate } = require("../middleware/auth.middleware");

const router = Router();

const buildActionToken = (payload) => {
  const secret = process.env.ADMIN_ACTION_SECRET || "admin-secret";
  return jwt.sign(payload, secret, { expiresIn: "1h" });
};

const verifyActionToken = (token) => {
  const secret = process.env.ADMIN_ACTION_SECRET || "admin-secret";
  return jwt.verify(token, secret);
};

router.post("/", authenticate, async (req, res) => {
  try {
    const { reason, comment, experienceId, reportedUserId } = req.body || {};
    if (!experienceId || !reportedUserId) {
      return res.status(400).json({ message: "experienceId and reportedUserId required" });
    }
    const experience = await Experience.findById(experienceId).select("title host");
    const reportedUser = await User.findById(reportedUserId).select("name email");
    const reporter = await User.findById(req.user.id).select("name email");

    const baseUrl = process.env.PUBLIC_BASE_URL || process.env.API_BASE_URL || "http://localhost:4000";
    const tokenPayload = {
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
      experienceId,
      reportedUserId,
    };
    const token = buildActionToken(tokenPayload);
    const actionLink = (action) => `${baseUrl}/admin/report-action?action=${action}&experienceId=${experienceId}&userId=${reportedUserId}&token=${token}`;

    const html = `
      <h3>New report</h3>
      <p><strong>Reason:</strong> ${reason || "(not provided)"}</p>
      <p><strong>Comment:</strong> ${comment || "(not provided)"}</p>
      <p><strong>Experience:</strong> ${experience?.title || experienceId} - <a href="${baseUrl}/experiences/${experienceId}">View</a></p>
      <p><strong>Reported user:</strong> ${reportedUser?.name || reportedUserId} (${reportedUser?.email || "n/a"})</p>
      <p><strong>Reporter:</strong> ${reporter?.name || req.user.id} (${reporter?.email || "n/a"})</p>
      <p>
        <a href="${actionLink("ban")}">Ban user</a> |
        <a href="${actionLink("hide")}">Hide experience</a> |
        <a href="${actionLink("ignore")}">Ignore report</a>
      </p>
    `;

    await sendMail({
      to: process.env.REPORT_EMAIL_TO || "mgdream1999@gmail.com",
      subject: `Report: ${experience?.title || experienceId}`,
      html,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("Report error", err);
    return res.status(500).json({ message: "Report failed" });
  }
});

router.get("/admin/report-action", async (req, res) => {
  try {
    const { action, experienceId, userId, token } = req.query;
    if (!token) return res.status(401).send("Missing token");
    try {
      verifyActionToken(token);
    } catch (err) {
      return res.status(401).send("Invalid or expired token");
    }
    if (!["ban", "hide", "ignore"].includes(action)) return res.status(400).send("Invalid action");

    if (action === "ban" && userId) {
      await User.findByIdAndUpdate(userId, { isBanned: true });
    }
    if (action === "hide" && experienceId) {
      await Experience.findByIdAndUpdate(experienceId, { isActive: false, status: "cancelled", soldOut: true, remainingSpots: 0 });
    }
    return res.send(`Action '${action}' applied.`);
  } catch (err) {
    console.error("Admin report action error", err);
    return res.status(500).send("Server error");
  }
});

module.exports = router;
