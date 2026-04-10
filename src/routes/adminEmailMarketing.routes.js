const { Router } = require("express");
const AdminAuditLog = require("../models/adminAuditLog.model");
const { authenticate, requireAdminAllowlist, requireOwnerAdmin } = require("../middleware/auth.middleware");
const { listCampaignHistory, sendTestCampaign, queueSubscriberCampaign } = require("../utils/emailMarketing");

const router = Router();

const getRequestIp = (req) =>
  String(
    req.headers["x-forwarded-for"] ||
      req.socket?.remoteAddress ||
      req.ip ||
      ""
  )
    .split(",")[0]
    .trim();

const writeAdminAuditLog = async (req, payload = {}) => {
  try {
    if (!req.user?.id || !req.user?.email) return;
    await AdminAuditLog.create({
      actorId: req.user.id,
      actorEmail: req.user.email,
      ip: getRequestIp(req),
      userAgent: String(req.headers["user-agent"] || ""),
      ...payload,
    });
  } catch (err) {
    console.error("Admin email marketing audit log write error", err);
  }
};

router.use(authenticate, requireAdminAllowlist, requireOwnerAdmin);

router.get("/history", async (req, res) => {
  try {
    const history = await listCampaignHistory({ limit: req.query.limit });
    return res.json(history);
  } catch (err) {
    console.error("email marketing history error", err);
    return res.status(500).json({ message: "Failed to load email marketing history" });
  }
});

router.post("/test", async (req, res) => {
  try {
    const campaign = await sendTestCampaign({
      requestedById: req.user.id,
      requestedByEmail: req.user.email,
      campaignInput: req.body || {},
    });

    await writeAdminAuditLog(req, {
      actionType: "EMAIL_MARKETING_TEST",
      targetType: "email_marketing_campaign",
      targetId: campaign.id,
      diff: {
        kind: campaign.kind,
        subject: campaign.subject,
        testEmail: campaign.testEmail,
        status: campaign.status,
      },
      meta: {
        audienceCount: campaign.audienceCount,
        sentCount: campaign.sentCount,
        failedCount: campaign.failedCount,
      },
    });

    return res.json({
      message: "Test email sent",
      campaign,
    });
  } catch (err) {
    const history = err?.history || null;
    if (history?.id) {
      await writeAdminAuditLog(req, {
        actionType: "EMAIL_MARKETING_TEST_FAILED",
        targetType: "email_marketing_campaign",
        targetId: history.id,
        diff: {
          subject: history.subject,
          testEmail: history.testEmail,
          status: history.status,
        },
        meta: {
          error: String(err?.message || err || "Failed to send test email"),
        },
      });
    }
    return res.status(400).json({ message: String(err?.message || err || "Failed to send test email") });
  }
});

router.post("/send", async (req, res) => {
  try {
    if (req.body?.confirmSend !== true) {
      return res.status(400).json({ message: "confirmSend must be true" });
    }

    const result = await queueSubscriberCampaign({
      requestedById: req.user.id,
      requestedByEmail: req.user.email,
      campaignInput: req.body || {},
    });

    await writeAdminAuditLog(req, {
      actionType: "EMAIL_MARKETING_SEND",
      targetType: "email_marketing_campaign",
      targetId: result.campaign.id,
      diff: {
        kind: result.campaign.kind,
        subject: result.campaign.subject,
        status: result.campaign.status,
      },
      meta: {
        audienceCount: result.audienceCount,
      },
    });

    return res.status(202).json({
      message: "Campaign queued for subscribers",
      campaign: result.campaign,
      audienceCount: result.audienceCount,
    });
  } catch (err) {
    const message = String(err?.message || err || "Failed to queue subscriber campaign");
    const status = /No subscribed recipients/i.test(message) ? 400 : 500;
    return res.status(status).json({ message });
  }
});

module.exports = router;
