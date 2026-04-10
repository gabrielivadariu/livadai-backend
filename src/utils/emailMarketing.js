const User = require("../models/user.model");
const EmailMarketingCampaign = require("../models/emailMarketingCampaign.model");
const { sendEmail } = require("./mailer");
const { buildMarketingExperienceEmail } = require("./emailTemplates");
const { generateUnsubscribeToken } = require("./marketingEmails");

const BATCH_SIZE = 20;
const MIN_BATCH_DELAY_MS = 1000;
const MAX_BATCH_DELAY_MS = 2000;
const FALLBACK_TEST_UNSUBSCRIBE_TOKEN = "test-preview";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBatchDelayMs = () =>
  MIN_BATCH_DELAY_MS + Math.floor(Math.random() * (MAX_BATCH_DELAY_MS - MIN_BATCH_DELAY_MS + 1));

const MARKETING_FOOTER_TEXT =
  "Primești acest email pentru că ai ales să primești noutăți LIVADAI. Te poți dezabona oricând.";

const normalizeText = (value, { field, required = true, max = 1000 } = {}) => {
  const text = String(value ?? "").trim().replace(/\r\n/g, "\n");
  if (required && !text) {
    throw new Error(`${field} is required`);
  }
  return text.slice(0, max);
};

const normalizeEmail = (value, { required = true, field = "email" } = {}) => {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) {
    if (required) throw new Error(`${field} is required`);
    return "";
  }
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!valid) throw new Error(`${field} must be a valid email`);
  return email.slice(0, 320);
};

const normalizeUrl = (value, { field = "ctaUrl" } = {}) => {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${field} is required`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${field} must be a valid absolute URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${field} must be a valid absolute URL`);
  }
  return parsed.toString().slice(0, 1000);
};

const normalizeCampaignPayload = (payload = {}, { includeTestEmail = false } = {}) => {
  const subject = normalizeText(payload.subject, { field: "subject", max: 140 });
  const introText = normalizeText(payload.introText, { field: "introText", max: 1600 });
  const mainExperienceTitle = normalizeText(payload.mainExperienceTitle, {
    field: "mainExperienceTitle",
    max: 140,
  });
  const mainExperienceText = normalizeText(payload.mainExperienceText, {
    field: "mainExperienceText",
    max: 1200,
  });
  const secondaryExperience1Title = normalizeText(payload.secondaryExperience1Title, {
    field: "secondaryExperience1Title",
    max: 140,
  });
  const secondaryExperience1Text = normalizeText(payload.secondaryExperience1Text, {
    field: "secondaryExperience1Text",
    max: 400,
  });
  const secondaryExperience2Title = normalizeText(payload.secondaryExperience2Title, {
    field: "secondaryExperience2Title",
    max: 140,
  });
  const secondaryExperience2Text = normalizeText(payload.secondaryExperience2Text, {
    field: "secondaryExperience2Text",
    max: 400,
  });
  const ctaLabel = normalizeText(payload.ctaLabel, { field: "ctaLabel", max: 60 });
  const ctaUrl = normalizeUrl(payload.ctaUrl, { field: "ctaUrl" });

  const normalized = {
    subject,
    introText,
    mainExperience: {
      title: mainExperienceTitle,
      summary: mainExperienceText,
    },
    secondaryExperiences: [
      { title: secondaryExperience1Title, summary: secondaryExperience1Text },
      { title: secondaryExperience2Title, summary: secondaryExperience2Text },
    ],
    ctaLabel,
    ctaUrl,
  };

  if (includeTestEmail) {
    normalized.testEmail = normalizeEmail(payload.testEmail, {
      required: true,
      field: "testEmail",
    });
  }

  return normalized;
};

const buildFrontendBaseUrl = () =>
  String(process.env.FRONTEND_URL || process.env.APP_URL || "https://www.livadai.com").replace(/\/$/, "");

const buildUnsubscribeBaseUrl = () =>
  String(
    process.env.PUBLIC_BASE_URL ||
      process.env.API_PUBLIC_URL ||
      process.env.NEXT_PUBLIC_API_URL ||
      "https://livadai-backend-production.up.railway.app"
  ).replace(/\/$/, "");

const buildUnsubscribeUrl = (token) =>
  `${buildUnsubscribeBaseUrl()}/unsubscribe?token=${encodeURIComponent(token || FALLBACK_TEST_UNSUBSCRIBE_TOKEN)}`;

const getMailTransportMode = () => {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_PORT) {
    return "smtp";
  }
  return "console-fallback";
};

const areEmailsEnabled = () => {
  if (process.env.EMAILS_ENABLED === undefined) return true;
  return process.env.EMAILS_ENABLED === "true";
};

const getSenderConfig = () => ({
  from: process.env.INFO_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_USER || "support@livadai.com",
  replyTo: process.env.SUPPORT_EMAIL || "support@livadai.com",
});

const buildCampaignHtml = (campaign, recipient) =>
  buildMarketingExperienceEmail({
    title: campaign.subject,
    introText: campaign.introText,
    experienceTitle: campaign.mainExperience?.title,
    experienceSummary: campaign.mainExperience?.summary,
    secondaryExperiences: campaign.secondaryExperiences || [],
    ctaLabel: campaign.ctaLabel,
    ctaUrl: campaign.ctaUrl,
    unsubscribeUrl: recipient.unsubscribeUrl,
    testingNotice: recipient.testingNotice,
    footerText: MARKETING_FOOTER_TEXT,
    logoUrl: `${buildFrontendBaseUrl()}/email/livadai-logo.png`,
  });

const eligibleRecipientsFilter = {
  marketingEmailOptIn: true,
  $or: [{ marketingEmailUnsubscribedAt: null }, { marketingEmailUnsubscribedAt: { $exists: false } }],
  email: { $exists: true, $ne: "" },
};

const getEligibleSubscriberCount = () => User.countDocuments(eligibleRecipientsFilter);

const ensureUserUnsubscribeToken = async (user) => {
  if (user?.unsubscribeToken) return user.unsubscribeToken;
  const nextToken = generateUnsubscribeToken();
  await User.updateOne(
    { _id: user._id, $or: [{ unsubscribeToken: { $exists: false } }, { unsubscribeToken: "" }, { unsubscribeToken: null }] },
    { $set: { unsubscribeToken: nextToken } }
  ).catch(() => {});
  return nextToken;
};

const loadEligibleRecipients = async () => {
  const users = await User.find(eligibleRecipientsFilter).select("_id email unsubscribeToken").lean();
  const recipients = [];

  for (const user of users) {
    if (!user?.email) continue;
    const token = user.unsubscribeToken || (await ensureUserUnsubscribeToken(user));
    recipients.push({
      email: String(user.email).trim().toLowerCase(),
      unsubscribeUrl: buildUnsubscribeUrl(token),
    });
  }

  return recipients;
};

const loadTestRecipient = async (testEmail) => {
  const email = normalizeEmail(testEmail, { required: true, field: "testEmail" });
  const user = await User.findOne({ email }).select("_id email unsubscribeToken").lean();
  const token = user ? await ensureUserUnsubscribeToken(user) : FALLBACK_TEST_UNSUBSCRIBE_TOKEN;
  return {
    email,
    unsubscribeUrl: buildUnsubscribeUrl(token),
    testingNotice:
      "Acesta este un email de test trimis din panoul admin LIVADAI pentru verificarea flow-ului de trimitere și a randării template-ului.",
  };
};

const sendCampaignEmail = async ({ campaign, recipient }) => {
  const sender = getSenderConfig();
  const html = buildCampaignHtml(campaign, recipient);

  await sendEmail({
    to: recipient.email,
    subject: campaign.subject,
    html,
    type: "official",
    from: sender.from,
    replyTo: sender.replyTo,
    userId: campaign.requestedById,
  });
};

const serializeCampaign = (campaign) => ({
  id: String(campaign._id),
  kind: campaign.kind || "",
  status: campaign.status || "",
  requestedByEmail: campaign.requestedByEmail || "",
  testEmail: campaign.testEmail || "",
  subject: campaign.subject || "",
  introText: campaign.introText || "",
  mainExperienceTitle: campaign.mainExperience?.title || "",
  ctaLabel: campaign.ctaLabel || "",
  ctaUrl: campaign.ctaUrl || "",
  audienceCount: Number(campaign.audienceCount || 0),
  sentCount: Number(campaign.sentCount || 0),
  failedCount: Number(campaign.failedCount || 0),
  transportMode: campaign.transportMode || "",
  lastError: campaign.lastError || "",
  createdAt: campaign.createdAt || null,
  updatedAt: campaign.updatedAt || null,
  startedAt: campaign.startedAt || null,
  completedAt: campaign.completedAt || null,
});

const createCampaignHistoryRecord = async ({
  requestedById,
  requestedByEmail,
  kind,
  campaign,
  testEmail = "",
  audienceCount = 0,
  status = "QUEUED",
  transportMode = getMailTransportMode(),
}) =>
  EmailMarketingCampaign.create({
    requestedById,
    requestedByEmail,
    kind,
    status,
    testEmail,
    audienceCount,
    transportMode,
    subject: campaign.subject,
    introText: campaign.introText,
    mainExperience: campaign.mainExperience,
    secondaryExperiences: campaign.secondaryExperiences,
    ctaLabel: campaign.ctaLabel,
    ctaUrl: campaign.ctaUrl,
  });

const sendTestCampaign = async ({ requestedById, requestedByEmail, campaignInput }) => {
  const campaign = normalizeCampaignPayload(campaignInput, { includeTestEmail: true });
  const history = await createCampaignHistoryRecord({
    requestedById,
    requestedByEmail,
    kind: "TEST",
    campaign,
    testEmail: campaign.testEmail,
    audienceCount: 1,
    status: "QUEUED",
  });

  try {
    const recipient = await loadTestRecipient(campaign.testEmail);
    await EmailMarketingCampaign.updateOne(
      { _id: history._id },
      { $set: { status: "SENDING", startedAt: new Date() } }
    );
    await sendCampaignEmail({ campaign: { ...campaign, requestedById }, recipient });
    const completedAt = new Date();
    const updated = await EmailMarketingCampaign.findByIdAndUpdate(
      history._id,
      {
        $set: {
          status: "SENT",
          sentCount: 1,
          failedCount: 0,
          completedAt,
        },
      },
      { new: true }
    );
    return serializeCampaign(updated || history);
  } catch (err) {
    const completedAt = new Date();
    const updated = await EmailMarketingCampaign.findByIdAndUpdate(
      history._id,
      {
        $set: {
          status: "FAILED",
          failedCount: 1,
          completedAt,
          lastError: String(err?.message || err || "Failed to send test campaign"),
          lastErrorAt: completedAt,
        },
      },
      { new: true }
    );
    throw Object.assign(new Error(String(err?.message || err || "Failed to send test campaign")), {
      history: serializeCampaign(updated || history),
    });
  }
};

const processQueuedCampaign = async (campaignId) => {
  const campaign = await EmailMarketingCampaign.findById(campaignId);
  if (!campaign || campaign.kind !== "SUBSCRIBER_SEND") return;
  if (!["QUEUED", "SENDING"].includes(String(campaign.status || "").toUpperCase())) return;

  const startedAt = new Date();
  await EmailMarketingCampaign.updateOne(
    { _id: campaign._id },
    { $set: { status: "SENDING", startedAt }, $unset: { lastError: "", lastErrorAt: "" } }
  );

  try {
    const recipients = await loadEligibleRecipients();
    let sentCount = 0;
    let failedCount = 0;
    let lastError = "";

    for (let index = 0; index < recipients.length; index += BATCH_SIZE) {
      const batch = recipients.slice(index, index + BATCH_SIZE);
      for (const recipient of batch) {
        try {
          await sendCampaignEmail({
            campaign: {
              subject: campaign.subject,
              introText: campaign.introText,
              mainExperience: campaign.mainExperience,
              secondaryExperiences: campaign.secondaryExperiences,
              ctaLabel: campaign.ctaLabel,
              ctaUrl: campaign.ctaUrl,
              requestedById: campaign.requestedById,
            },
            recipient,
          });
          sentCount += 1;
        } catch (err) {
          failedCount += 1;
          lastError = String(err?.message || err || "Failed to send to one or more recipients");
        }
      }

      await EmailMarketingCampaign.updateOne(
        { _id: campaign._id },
        lastError
          ? {
              $set: {
                sentCount,
                failedCount,
                lastError,
                lastErrorAt: new Date(),
              },
            }
          : {
              $set: {
                sentCount,
                failedCount,
              },
              $unset: {
                lastError: "",
                lastErrorAt: "",
              },
            }
      );

      if (index + BATCH_SIZE < recipients.length) {
        await sleep(randomBatchDelayMs());
      }
    }

    const completedAt = new Date();
    await EmailMarketingCampaign.updateOne(
      { _id: campaign._id },
      lastError
        ? {
            $set: {
              sentCount,
              failedCount,
              completedAt,
              status: failedCount ? (sentCount ? "PARTIAL" : "FAILED") : "SENT",
              lastError,
              lastErrorAt: completedAt,
            },
          }
        : {
            $set: {
              sentCount,
              failedCount,
              completedAt,
              status: failedCount ? (sentCount ? "PARTIAL" : "FAILED") : "SENT",
            },
            $unset: {
              lastError: "",
              lastErrorAt: "",
            },
          }
    );
  } catch (err) {
    const failedAt = new Date();
    await EmailMarketingCampaign.updateOne(
      { _id: campaign._id },
      {
        $set: {
          status: "FAILED",
          completedAt: failedAt,
          lastError: String(err?.message || err || "Failed to process campaign"),
          lastErrorAt: failedAt,
        },
      }
    );
    console.error("processQueuedCampaign error", err);
  }
};

const queueSubscriberCampaign = async ({ requestedById, requestedByEmail, campaignInput }) => {
  const campaign = normalizeCampaignPayload(campaignInput);
  const audienceCount = await getEligibleSubscriberCount();
  if (!audienceCount) {
    throw new Error("No subscribed recipients available");
  }

  const history = await createCampaignHistoryRecord({
    requestedById,
    requestedByEmail,
    kind: "SUBSCRIBER_SEND",
    campaign,
    audienceCount,
  });

  setImmediate(() => {
    void processQueuedCampaign(history._id);
  });

  return {
    campaign: serializeCampaign(history),
    audienceCount,
  };
};

const listCampaignHistory = async ({ limit = 20 } = {}) => {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 50));
  const [items, activeSubscribers] = await Promise.all([
    EmailMarketingCampaign.find({})
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean(),
    getEligibleSubscriberCount(),
  ]);

  return {
    summary: {
      activeSubscribers,
      transportMode: getMailTransportMode(),
      emailsEnabled: areEmailsEnabled(),
    },
    items: items.map(serializeCampaign),
  };
};

module.exports = {
  normalizeCampaignPayload,
  listCampaignHistory,
  sendTestCampaign,
  queueSubscriberCampaign,
  getMailTransportMode,
};
