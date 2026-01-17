const nodemailer = require("nodemailer");

let cachedTransporter = null;

const BRAND_COLOR = "#06b6d4";
const FOOTER_MARKER = "<!-- LIVADAI_FOOTER -->";

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

const resolveFrom = ({ type, from }) => {
  if (from) return from;
  if (type === "report") return process.env.REPORTS_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_USER;
  if (type === "official") return process.env.EMAIL_FROM || process.env.SMTP_USER;
  if (type === "welcome_explorer" || type === "welcome_host") {
    return process.env.HELLO_EMAIL || process.env.EMAIL_FROM || process.env.SMTP_USER;
  }
  if (type === "booking_explorer" || type === "booking_host" || type === "booking_cancelled" || type === "booking_reminder") {
    return process.env.EMAIL_FROM || process.env.SMTP_USER;
  }
  return process.env.EMAIL_FROM || process.env.SMTP_USER;
};

const resolveReplyTo = ({ type, replyTo }) => {
  if (replyTo) return replyTo;
  if (["official", "welcome_explorer", "welcome_host", "booking_explorer", "booking_host", "booking_cancelled", "booking_reminder"].includes(type)) {
    return process.env.SUPPORT_EMAIL;
  }
  return undefined;
};

const buildFooterHtml = () => {
  const termsUrl = process.env.TERMS_URL || "https://livadai.com/terms";
  const privacyUrl = process.env.PRIVACY_URL || "https://livadai.com/privacy";
  return `
    ${FOOTER_MARKER}
    <div style="margin-top:18px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:12px;color:#94a3b8;">
      <div>Ai nevoie de ajutor? <a href="mailto:${process.env.SUPPORT_EMAIL || "support@livadai.com"}" style="color:#0ea5a6;text-decoration:none;">${process.env.SUPPORT_EMAIL || "support@livadai.com"}</a></div>
      <div style="margin-top:6px;">
        <a href="${termsUrl}" style="color:#0ea5a6;text-decoration:none;">Terms</a> ·
        <a href="${privacyUrl}" style="color:#0ea5a6;text-decoration:none;">Privacy</a>
      </div>
      <div style="margin-top:6px;">© LIVADAI</div>
    </div>
  `;
};

const ensureFooter = (html) => {
  if (!html) return buildFooterHtml();
  if (html.includes(FOOTER_MARKER)) return html;
  return `${html}${buildFooterHtml()}`;
};

const buildBrandedEmail = ({ title, intro, bodyHtml, ctaLabel, ctaUrl, footer }) => {
  const introHtml = intro ? `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.6;color:#334155;">${intro}</p>` : "";
  const ctaHtml = ctaLabel && ctaUrl
    ? `<p style="margin:18px 0 6px 0;"><a href="${ctaUrl}" style="display:inline-block;padding:12px 18px;background:${BRAND_COLOR};color:#ffffff;border-radius:10px;text-decoration:none;font-weight:700;">${ctaLabel}</a></p>`
    : "";
  const footerHtml = footer ? `<p style="margin:18px 0 0 0;font-size:12px;color:#94a3b8;">${footer}</p>` : "";
  return `
    <div style="background:#f3f4f6;padding:24px 12px;font-family:Arial,sans-serif;">
      <table align="center" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:${BRAND_COLOR};color:#ffffff;text-align:center;padding:18px 12px;">
            <div style="font-size:22px;font-weight:800;letter-spacing:1px;">LIVADAI</div>
            <div style="font-size:12px;opacity:0.9;margin-top:4px;">Explorers & Hosts</div>
          </td>
        </tr>
        <tr>
          <td style="padding:22px 24px;color:#0f172a;">
            <h2 style="margin:0 0 10px 0;font-size:20px;font-weight:800;color:#0f172a;">${title}</h2>
            ${introHtml}
            ${bodyHtml || ""}
            ${ctaHtml}
            ${footerHtml}
            ${buildFooterHtml()}
          </td>
        </tr>
      </table>
    </div>
  `;
};

const shouldSendEmails = () => {
  if (process.env.EMAILS_ENABLED === undefined) return true;
  return process.env.EMAILS_ENABLED === "true";
};

const sendEmail = async ({ to, subject, html, type, from, replyTo, userId }) => {
  const resolvedFrom = resolveFrom({ type, from });
  const resolvedReplyTo = resolveReplyTo({ type, replyTo });
  const finalHtml = ensureFooter(html);

  if (!shouldSendEmails()) {
    console.log("=== MAIL (disabled) ===");
    console.log("From:", resolvedFrom);
    if (resolvedReplyTo) console.log("Reply-To:", resolvedReplyTo);
    console.log("To:", to);
    console.log("Subject:", subject);
    console.log(finalHtml);
    console.log("=== END MAIL ===");
    return;
  }

  const transporter = getTransporter();
  if (!transporter) {
    console.log("=== MAIL (console fallback) ===");
    console.log("From:", resolvedFrom);
    if (resolvedReplyTo) console.log("Reply-To:", resolvedReplyTo);
    console.log("To:", to);
    console.log("Subject:", subject);
    console.log(finalHtml);
    console.log("=== END MAIL ===");
    return;
  }
  try {
    const info = await transporter.sendMail({
      from: resolvedFrom,
      replyTo: resolvedReplyTo,
      to,
      subject,
      html: finalHtml,
    });
    console.log("Mailer sent:", info?.messageId || info);
  } catch (err) {
    console.error("Mailer sendMail error:", err?.message || err);
    throw err;
  }
};

exports.sendEmail = sendEmail;
exports.buildBrandedEmail = buildBrandedEmail;
exports.ensureFooter = ensureFooter;
