const nodemailer = require("nodemailer");

let cachedTransporter = null;

const BRAND_COLOR = "#00bcd4";
const ACCENT_COLOR = "#16a34a";
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

const resolveFrom = ({ type, from, subject }) => {
  if (from) return from;
  const fallback = process.env.EMAIL_FROM || process.env.SMTP_USER;
  const normalizedSubject = (subject || "").toLowerCase();
  const isDispute = normalizedSubject.includes("dispute") || normalizedSubject.includes("dispută");
  const isAttendance = normalizedSubject.includes("confirmă prezența") || normalizedSubject.includes("confirm attendance");
  const isContentReport =
    normalizedSubject.includes("content report") ||
    normalizedSubject.startsWith("report:");

  if (type === "welcome_explorer" || type === "welcome_host") {
    return process.env.HELLO_EMAIL || fallback;
  }
  if (type === "booking_explorer" || type === "booking_host") {
    return process.env.BOOKINGS_EMAIL || fallback;
  }
  if (type === "booking_reminder") {
    return process.env.NOTIFICATIONS_EMAIL || fallback;
  }
  if (type === "booking_cancelled") {
    return process.env.INFO_EMAIL || fallback;
  }
  if (type === "report") {
    if (isContentReport) {
      return process.env.SUPPORT_EMAIL || fallback;
    }
    return process.env.REPORTS_EMAIL || fallback;
  }
  if (type === "official") {
    if (isDispute) return process.env.SUPPORT_EMAIL || fallback;
    if (isAttendance) return process.env.NOTIFICATIONS_EMAIL || fallback;
    return process.env.INFO_EMAIL || fallback;
  }
  return fallback;
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
    <div style="margin-top:20px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#94a3b8;">
      <div>Ai nevoie de ajutor? <a href="mailto:${process.env.SUPPORT_EMAIL || "support@livadai.com"}" style="color:${BRAND_COLOR};text-decoration:none;">${process.env.SUPPORT_EMAIL || "support@livadai.com"}</a></div>
      <div style="margin-top:6px;">Need help? <a href="mailto:${process.env.SUPPORT_EMAIL || "support@livadai.com"}" style="color:${BRAND_COLOR};text-decoration:none;">${process.env.SUPPORT_EMAIL || "support@livadai.com"}</a></div>
      <div style="margin-top:8px;">
        <a href="${termsUrl}" style="color:${BRAND_COLOR};text-decoration:none;">Termeni</a> ·
        <a href="${privacyUrl}" style="color:${BRAND_COLOR};text-decoration:none;">Confidențialitate</a>
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

const buildBrandedEmail = ({ title, intro, bodyHtml, ctaLabel, ctaUrl, footer, ctaColor, headerSubtitle }) => {
  const introHtml = intro ? `<p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;color:#334155;">${intro}</p>` : "";
  const resolvedCtaColor = ctaColor || BRAND_COLOR;
  const ctaHtml =
    ctaLabel && ctaUrl
      ? `<p style="margin:18px 0 6px 0;"><a href="${ctaUrl}" style="display:inline-block;padding:12px 20px;background:${resolvedCtaColor};color:#ffffff;border-radius:999px;text-decoration:none;font-weight:700;letter-spacing:0.2px;">${ctaLabel}</a></p>`
      : "";
  const footerHtml = footer ? `<p style="margin:18px 0 0 0;font-size:12px;color:#94a3b8;">${footer}</p>` : "";
  const sub = headerSubtitle || "Experiențe reale, oameni reali";
  return `
    <div style="background:#f5f7fb;padding:26px 12px;font-family:Arial,sans-serif;">
      <table align="center" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 12px 30px rgba(15,23,42,0.08);">
        <tr>
          <td style="background:${BRAND_COLOR};color:#ffffff;text-align:center;padding:20px 12px;">
            <div style="font-size:22px;font-weight:800;letter-spacing:1px;">LIVADAI</div>
            <div style="font-size:12px;opacity:0.9;margin-top:4px;">${sub}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 26px;color:#0f172a;">
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

const sendWithResend = async ({ from, to, subject, html, replyTo }) => {
  if (!process.env.RESEND_API_KEY) return false;
  const payload = {
    from,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
  };
  if (replyTo) payload.reply_to = replyTo;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error: ${res.status} ${body}`);
  }
  return true;
};

const sendEmail = async ({ to, subject, html, type, from, replyTo, userId }) => {
  const resolvedFrom = resolveFrom({ type, from, subject });
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

  try {
    const sent = await sendWithResend({
      from: resolvedFrom,
      to,
      subject,
      html: finalHtml,
      replyTo: resolvedReplyTo,
    });
    if (sent) {
      console.log("Mailer sent via Resend");
      return;
    }
  } catch (err) {
    console.error("Resend sendEmail error:", err?.message || err);
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
