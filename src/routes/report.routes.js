const { Router } = require("express");
const jwt = require("jsonwebtoken");
const { sendEmail } = require("../utils/mailer");
const Experience = require("../models/experience.model");
const User = require("../models/user.model");
const Report = require("../models/report.model");
const { sendContentReportEmail } = require("../utils/reports");
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

    const report = await Report.create({
      type: "CONTENT",
      experience: experienceId,
      host: experience?.host,
      reporter: req.user?.id,
      targetType: "EXPERIENCE",
      targetUserId: reportedUserId,
      reason,
      comment,
      affectsPayout: false,
      deadlineAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    });

    const reportsEmail = process.env.REPORTS_EMAIL;
    if (!reportsEmail) {
      console.warn("[REPORT] REPORTS_EMAIL missing; skipping email");
      return res.json({ success: true });
    }

    await sendContentReportEmail({
      experience,
      reporter,
      reason,
      comment,
      reportsEmail,
      reportId: report._id,
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
