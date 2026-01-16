const nodemailer = require("nodemailer");

let cachedTransporter = null;

const getTransporter = () => {
  if (cachedTransporter) return cachedTransporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.SMTP_PORT) {
    console.warn("Mailer: SMTP env vars missing, emails will be logged to console only.");
    return null;
  }
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return cachedTransporter;
};

const sendMail = async ({ to, subject, html }) => {
  const transporter = getTransporter();
  if (!transporter) {
    console.log("=== MAIL (console fallback) ===");
    console.log("To:", to);
    console.log("Subject:", subject);
    console.log(html);
    console.log("=== END MAIL ===");
    return;
  }
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      html,
    });
    console.log("Mailer sent:", info?.messageId || info);
  } catch (err) {
    console.error("Mailer sendMail error:", err?.message || err);
    throw err;
  }
};

module.exports = { sendMail };
