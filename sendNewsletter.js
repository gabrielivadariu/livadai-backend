require("dotenv").config();

const TEST_MODE = true;
const TEST_EMAIL = "livadariu.ga@icloud.com";
const BATCH_SIZE = 20;
const CTA_URL = "https://app.livadai.com";
const SUBJECT = "Weekendul ăsta merită trăit altfel";
const FROM_EMAIL = process.env.INFO_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_USER || "support@livadai.com";
const REPLY_TO_EMAIL = process.env.SUPPORT_EMAIL || "support@livadai.com";

const { sendEmail } = require("./src/utils/mailer");
const { buildMarketingExperienceEmail } = require("./src/utils/emailTemplates");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBatchDelayMs = () => 1000 + Math.floor(Math.random() * 1001);

const getMailTransportMode = () => {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.SMTP_PORT) {
    return "smtp";
  }
  return "console-fallback";
};

const logRunContext = () => {
  const transportMode = getMailTransportMode();
  console.log("Newsletter configuration");
  console.log(`- TEST_MODE: ${TEST_MODE ? "true" : "false"}`);
  console.log(`- transport: ${transportMode}`);
  console.log(`- from: ${FROM_EMAIL}`);
  console.log(`- reply-to: ${REPLY_TO_EMAIL}`);
  console.log(`- EMAILS_ENABLED: ${process.env.EMAILS_ENABLED === undefined ? "(unset)" : process.env.EMAILS_ENABLED}`);
  if (transportMode === "console-fallback") {
    console.log("WARNING: No RESEND_API_KEY or SMTP config detected. The script will only log the email content.");
  }
};

const newsletterContent = {
  introText:
    "Salut 👋\n\nDin când în când, îți trimitem doar ce merită.\nExperiențe reale, oameni faini și locuri care nu se uită după două poze.\n\nUite 3 experiențe care te pot scoate din rutină 👇",
  experienceTitle: "Tabăra oamenilor liberi",
  experienceSummary:
    "Foc de tabără, natură, oameni mișto și un weekend care chiar îți schimbă ritmul.",
  secondaryExperiences: [
    {
      title: "Atelier de ceramică tradițională",
      summary: "Un atelier liniștit, cu lut, răbdare și bucuria de a face ceva real cu mâinile tale.",
    },
    {
      title: "Tur culinar local autentic",
      summary: "Gusturi locale, povești de la gazde și o Românie care se descoperă cel mai bine la masă.",
    },
  ],
  ctaLabel: "Descoperă toate experiențele",
  footerText: "Primești acest email pentru că ai ales să primești noutăți LIVADAI. Te poți dezabona oricând.",
};

const buildUnsubscribeUrl = (token) => {
  const unsubscribeBaseUrl =
    process.env.PUBLIC_BASE_URL ||
    process.env.API_PUBLIC_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    "https://livadai-backend-production.up.railway.app";
  return `${String(unsubscribeBaseUrl).replace(/\/$/, "")}/unsubscribe?token=${encodeURIComponent(token)}`;
};

const getTestRecipients = () => [
  {
    email: TEST_EMAIL,
    unsubscribeUrl: buildUnsubscribeUrl("test-preview"),
    testingNotice:
      "Acesta este un email tehnic de test pentru verificarea flow-ului de trimitere și a randării template-ului newsletter LIVADAI.",
  },
];

const loadEligibleRecipients = async () => {
  const { connectDB } = require("./src/config/db");
  const mongoose = require("mongoose");
  const User = require("./src/models/user.model");

  await connectDB();
  try {
    const recipients = await User.find({
      marketingEmailOptIn: true,
      $or: [{ marketingEmailUnsubscribedAt: null }, { marketingEmailUnsubscribedAt: { $exists: false } }],
      email: { $exists: true, $ne: "" },
    })
      .select("email unsubscribeToken")
      .lean();

    return recipients
      .filter((user) => user?.email && user?.unsubscribeToken)
      .map((user) => ({
        email: user.email,
        unsubscribeUrl: buildUnsubscribeUrl(user.unsubscribeToken),
      }));
  } finally {
    await mongoose.disconnect().catch(() => {});
  }
};

const sendBatch = async (batch, batchIndex, totalBatches) => {
  console.log(`Sending batch ${batchIndex + 1}/${totalBatches} (${batch.length} recipient${batch.length === 1 ? "" : "s"})`);
  for (const recipient of batch) {
    const html = buildMarketingExperienceEmail({
      title: SUBJECT,
      introText: newsletterContent.introText.replace(/\n/g, "<br />"),
      experienceTitle: newsletterContent.experienceTitle,
      experienceSummary: newsletterContent.experienceSummary,
      secondaryExperiences: newsletterContent.secondaryExperiences,
      ctaLabel: newsletterContent.ctaLabel,
      ctaUrl: CTA_URL,
      unsubscribeUrl: recipient.unsubscribeUrl,
      testingNotice: recipient.testingNotice,
      footerText: newsletterContent.footerText,
    });

    await sendEmail({
      to: recipient.email,
      subject: SUBJECT,
      html,
      type: "official",
      from: FROM_EMAIL,
      replyTo: REPLY_TO_EMAIL,
    });
    console.log(`Newsletter sent to ${recipient.email}`);
  }
};

const main = async () => {
  logRunContext();
  const recipients = TEST_MODE ? getTestRecipients() : await loadEligibleRecipients();

  if (!recipients.length) {
    console.log("No recipients found. Nothing to send.");
    return;
  }

  console.log(
    TEST_MODE
      ? `TEST_MODE enabled. Sending technical preview to ${TEST_EMAIL}.`
      : `Sending newsletter to ${recipients.length} eligible recipients.`
  );

  const batches = [];
  for (let index = 0; index < recipients.length; index += BATCH_SIZE) {
    batches.push(recipients.slice(index, index + BATCH_SIZE));
  }

  for (let index = 0; index < batches.length; index += 1) {
    await sendBatch(batches[index], index, batches.length);
    if (index < batches.length - 1) {
      const delayMs = randomBatchDelayMs();
      console.log(`Waiting ${delayMs}ms before next batch...`);
      await sleep(delayMs);
    }
  }

  console.log("Newsletter script completed.");
};

main().catch((err) => {
  console.error("sendNewsletter failed", err);
  process.exit(1);
});
