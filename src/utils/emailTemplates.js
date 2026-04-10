const { buildBrandedEmail, FOOTER_MARKER } = require("./mailer");
const PRIMARY = "#00bcd4";
const ACCENT = "#16a34a";
const DEEP_TEXT = "#0f172a";
const MUTED_TEXT = "#475569";
const SURFACE = "#ffffff";
const SOFT_SURFACE = "#f4fbfd";

const escapeHtml = (value = "") =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderPlainTextParagraphs = (value = "", { color = MUTED_TEXT, fontSize = 15, lineHeight = 1.7 } = {}) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text
    .split(/\n{2,}/)
    .map((part) => {
      const html = escapeHtml(part).replace(/\n/g, "<br />");
      return `<p style="margin:0 0 14px 0;font-size:${fontSize}px;line-height:${lineHeight};color:${color};">${html}</p>`;
    })
    .join("");
};

const formatExperienceDate = (exp) => {
  const startDate = exp?.startsAt || exp?.startDate || exp?.date;
  if (!startDate) return "Data neconfirmată";
  return new Date(startDate).toLocaleDateString("ro-RO", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
};

const formatExperienceLocation = (exp) => {
  return (
    exp?.location?.formattedAddress ||
    exp?.address ||
    [exp?.street, exp?.streetNumber, exp?.city, exp?.country].filter(Boolean).join(" ") ||
    "Locație disponibilă în aplicație"
  );
};

const buildBilingualSection = ({ roTitle, roBody, enTitle, enBody }) => `
  <div style="margin:0 0 16px 0;">
    <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:6px;">${roTitle}</div>
    ${roBody}
  </div>
  <div style="height:1px;background:#e2e8f0;margin:16px 0;"></div>
  <div style="margin:0 0 8px 0;">
    <div style="font-size:14px;font-weight:800;color:#0f172a;margin-bottom:6px;">${enTitle}</div>
    ${enBody}
  </div>
`;

const buildWelcomeEmail = ({ ctaUrl }) => {
  const bodyHtml = buildBilingualSection({
    roTitle: "Bine ai venit în LIVADAI",
    roBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">LIVADAI este locul unde descoperi experiențe reale, create de oameni ca tine.</p>
      <p style="margin:0;font-size:15px;color:#334155;">Inspiră-te, explorează și trăiește momente memorabile.</p>
    `,
    enTitle: "Welcome to LIVADAI",
    enBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">LIVADAI is where you discover real experiences, created by people like you.</p>
      <p style="margin:0;font-size:15px;color:#334155;">Explore, connect, and make memories.</p>
    `,
  });
  return buildBrandedEmail({
    title: "Bine ai venit / Welcome",
    intro: "Descoperă experiențe create de oameni ca tine.",
    bodyHtml,
    ctaLabel: "Explorează experiențe",
    ctaUrl,
  });
};

const buildEmailVerificationEmail = ({ code, expiresMinutes }) => {
  const bodyHtml = buildBilingualSection({
    roTitle: "Codul tău de verificare",
    roBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Folosește codul de mai jos pentru a confirma emailul:</p>
      <div style="display:inline-block;padding:10px 16px;border-radius:10px;background:#ecfeff;color:#0f172a;font-weight:800;letter-spacing:2px;font-size:18px;">${code}</div>
      <p style="margin:10px 0 0 0;font-size:13px;color:#64748b;">Expiră în ${expiresMinutes} minute.</p>
    `,
    enTitle: "Your verification code",
    enBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Use the code below to verify your email:</p>
      <div style="display:inline-block;padding:10px 16px;border-radius:10px;background:#ecfeff;color:#0f172a;font-weight:800;letter-spacing:2px;font-size:18px;">${code}</div>
      <p style="margin:10px 0 0 0;font-size:13px;color:#64748b;">Expires in ${expiresMinutes} minutes.</p>
    `,
  });
  return buildBrandedEmail({
    title: "Verificare email / Verify email",
    intro: "Pentru siguranța contului tău.",
    bodyHtml,
  });
};

const buildPasswordResetEmail = ({ resetUrl, code }) => {
  const bodyHtml = buildBilingualSection({
    roTitle: "Resetare parolă",
    roBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Cineva a cerut resetarea parolei pentru contul tău.</p>
      <p style="margin:0 0 12px 0;font-size:15px;color:#334155;">Dacă nu ai cerut asta, poți ignora acest email.</p>
      ${code ? `<div style="display:inline-block;padding:10px 16px;border-radius:10px;background:#ecfeff;color:#0f172a;font-weight:800;letter-spacing:2px;font-size:18px;">${code}</div>` : ""}
    `,
    enTitle: "Password reset",
    enBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Someone requested a password reset for your account.</p>
      <p style="margin:0 0 12px 0;font-size:15px;color:#334155;">If it wasn’t you, you can ignore this email.</p>
      ${code ? `<div style="display:inline-block;padding:10px 16px;border-radius:10px;background:#ecfeff;color:#0f172a;font-weight:800;letter-spacing:2px;font-size:18px;">${code}</div>` : ""}
    `,
  });
  return buildBrandedEmail({
    title: "Resetare parolă / Password reset",
    intro: "Securitatea contului tău este importantă.",
    bodyHtml,
    ctaLabel: resetUrl ? "Resetează parola" : undefined,
    ctaUrl: resetUrl,
  });
};

const buildPasswordChangedEmail = () => {
  const bodyHtml = buildBilingualSection({
    roTitle: "Parola ta a fost schimbată",
    roBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Parola contului tău LIVADAI a fost actualizată.</p>
      <p style="margin:0;font-size:15px;color:#334155;">Dacă nu ai făcut această schimbare, contactează suportul imediat.</p>
    `,
    enTitle: "Your password was changed",
    enBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Your LIVADAI password has been updated.</p>
      <p style="margin:0;font-size:15px;color:#334155;">If you did not do this, please contact support immediately.</p>
    `,
  });
  return buildBrandedEmail({
    title: "Parolă schimbată / Password changed",
    intro: "Notificare de securitate.",
    bodyHtml,
  });
};

const buildEmailChangedEmail = ({ newEmail }) => {
  const bodyHtml = buildBilingualSection({
    roTitle: "Email actualizat",
    roBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Emailul contului tău LIVADAI a fost schimbat.</p>
      ${newEmail ? `<p style="margin:0;font-size:15px;color:#334155;"><strong>Noul email:</strong> ${newEmail}</p>` : ""}
    `,
    enTitle: "Email updated",
    enBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Your LIVADAI account email has been changed.</p>
      ${newEmail ? `<p style="margin:0;font-size:15px;color:#334155;"><strong>New email:</strong> ${newEmail}</p>` : ""}
    `,
  });
  return buildBrandedEmail({
    title: "Email schimbat / Email changed",
    intro: "Notificare de securitate.",
    bodyHtml,
  });
};

const buildAccountDeletedEmail = () => {
  const bodyHtml = buildBilingualSection({
    roTitle: "Cont șters",
    roBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Contul tău LIVADAI a fost șters.</p>
      <p style="margin:0;font-size:15px;color:#334155;">Ne pare rău să te vedem plecând.</p>
    `,
    enTitle: "Account deleted",
    enBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Your LIVADAI account has been deleted.</p>
      <p style="margin:0;font-size:15px;color:#334155;">We're sorry to see you go.</p>
    `,
  });
  return buildBrandedEmail({
    title: "Cont șters / Account deleted",
    intro: "Confirmare.",
    bodyHtml,
  });
};

const buildDeleteAccountOtpEmail = ({ code, expiresMinutes }) => {
  const bodyHtml = buildBilingualSection({
    roTitle: "Confirmă ștergerea contului",
    roBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Folosește codul de mai jos pentru a confirma ștergerea contului:</p>
      <div style="display:inline-block;padding:10px 16px;border-radius:10px;background:#fee2e2;color:#991b1b;font-weight:800;letter-spacing:2px;font-size:18px;">${code}</div>
      <p style="margin:10px 0 0 0;font-size:13px;color:#64748b;">Expiră în ${expiresMinutes} minute.</p>
    `,
    enTitle: "Confirm account deletion",
    enBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Use the code below to confirm account deletion:</p>
      <div style="display:inline-block;padding:10px 16px;border-radius:10px;background:#fee2e2;color:#991b1b;font-weight:800;letter-spacing:2px;font-size:18px;">${code}</div>
      <p style="margin:10px 0 0 0;font-size:13px;color:#64748b;">Expires in ${expiresMinutes} minutes.</p>
    `,
  });
  return buildBrandedEmail({
    title: "Ștergere cont / Account deletion",
    intro: "Confirmare necesară.",
    bodyHtml,
  });
};

const buildBookingConfirmedEmail = ({ experience, bookingId, ctaUrl, role, seatsBooked, totalSeats, remainingSeats }) => {
  const dateLabel = formatExperienceDate(experience);
  const locationLabel = formatExperienceLocation(experience);
  const title = role === "host" ? "Rezervare confirmată / Booking confirmed" : "Booking confirmat / Booking confirmed";
  const intro =
    role === "host"
      ? "Ai primit o rezervare nouă."
      : "Rezervarea ta este confirmată.";
  const showSeats = typeof totalSeats === "number" && totalSeats > 1;
  const bodyHtml = buildBilingualSection({
    roTitle: "Detalii esențiale",
    roBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Experiență:</strong> ${experience?.title || "LIVADAI"}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Dată:</strong> ${dateLabel}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Locație:</strong> ${locationLabel}</p>
      ${showSeats ? `<p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Locuri rezervate:</strong> ${seatsBooked || 1}</p>` : ""}
      ${showSeats ? `<p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Total locuri:</strong> ${totalSeats}</p>` : ""}
      ${showSeats ? `<p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Locuri rămase:</strong> ${remainingSeats ?? 0}</p>` : ""}
      ${bookingId ? `<p style="margin:0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
    enTitle: "Key details",
    enBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Experience:</strong> ${experience?.title || "LIVADAI"}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Date:</strong> ${dateLabel}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Location:</strong> ${locationLabel}</p>
      ${showSeats ? `<p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Seats booked:</strong> ${seatsBooked || 1}</p>` : ""}
      ${showSeats ? `<p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Total seats:</strong> ${totalSeats}</p>` : ""}
      ${showSeats ? `<p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Seats left:</strong> ${remainingSeats ?? 0}</p>` : ""}
      ${bookingId ? `<p style="margin:0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
  });
  return buildBrandedEmail({
    title,
    intro,
    bodyHtml,
    ctaLabel: role === "host" ? "Vezi rezervarea" : "Vezi booking-ul",
    ctaUrl,
  });
};

const buildBookingReminderEmail = ({ experience, bookingId, ctaUrl }) => {
  const dateLabel = formatExperienceDate(experience);
  const locationLabel = formatExperienceLocation(experience);
  const bodyHtml = buildBilingualSection({
    roTitle: "Mâine ai o experiență LIVADAI",
    roBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Experiență:</strong> ${experience?.title || "LIVADAI"}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Dată:</strong> ${dateLabel}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Locație:</strong> ${locationLabel}</p>
      ${bookingId ? `<p style="margin:0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
    enTitle: "Your LIVADAI experience is tomorrow",
    enBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Experience:</strong> ${experience?.title || "LIVADAI"}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Date:</strong> ${dateLabel}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Location:</strong> ${locationLabel}</p>
      ${bookingId ? `<p style="margin:0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
  });
  return buildBrandedEmail({
    title: "Reminder / Reminder",
    intro: "Ne vedem curând.",
    bodyHtml,
    ctaLabel: "Vezi detalii",
    ctaUrl,
  });
};

const buildBookingCancelledEmail = ({ experience, bookingId, ctaUrl, role }) => {
  const dateLabel = formatExperienceDate(experience);
  const bodyHtml = buildBilingualSection({
    roTitle: "Experiență anulată",
    roBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Experiența "${experience?.title || "LIVADAI"}" a fost anulată.</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Plata va fi returnată cât mai curând, conform politicii de refund.</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Dată:</strong> ${dateLabel}</p>
      ${bookingId ? `<p style="margin:0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
    enTitle: "Experience cancelled",
    enBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">"${experience?.title || "LIVADAI"}" has been cancelled.</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Your payment will be refunded according to the refund policy.</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Date:</strong> ${dateLabel}</p>
      ${bookingId ? `<p style="margin:0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
  });
  return buildBrandedEmail({
    title: "Rezervare anulată / Booking cancelled",
    intro: role === "host" ? "Rezervarea a fost anulată." : "Ne pare rău pentru inconvenient.",
    bodyHtml,
    ctaLabel: "Vezi detalii",
    ctaUrl,
    ctaColor: ACCENT,
  });
};

const buildAttendanceReminderEmail = ({ experience, bookingId, ctaUrl }) => {
  const bodyHtml = buildBilingualSection({
    roTitle: "Confirmă prezența",
    roBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Te rugăm să confirmi prezența pentru "${experience?.title || "LIVADAI"}".</p>
      <p style="margin:0;font-size:15px;color:#334155;">Acest pas ne ajută să finalizăm corect plățile.</p>
      ${bookingId ? `<p style="margin:10px 0 0 0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
    enTitle: "Confirm attendance",
    enBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Please confirm attendance for "${experience?.title || "LIVADAI"}".</p>
      <p style="margin:0;font-size:15px;color:#334155;">This helps us complete payments correctly.</p>
      ${bookingId ? `<p style="margin:10px 0 0 0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
  });
  return buildBrandedEmail({
    title: "Confirmă prezența / Confirm attendance",
    intro: "Un reminder prietenos.",
    bodyHtml,
    ctaLabel: "Confirmă prezența",
    ctaUrl,
  });
};

const buildDisputeOpenedEmail = ({ experience, bookingId }) => {
  const bodyHtml = buildBilingualSection({
    roTitle: "Dispută deschisă",
    roBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">O experiență a fost raportată. Plata este temporar blocată până la clarificarea situației.</p>
      ${bookingId ? `<p style="margin:10px 0 0 0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
    enTitle: "Dispute opened",
    enBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">An experience has been reported. The payout is temporarily blocked while the issue is reviewed.</p>
      ${bookingId ? `<p style="margin:10px 0 0 0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
  });
  return buildBrandedEmail({
    title: "Dispută / Dispute",
    intro: "Notificare importantă.",
    bodyHtml,
  });
};

const buildRefundInitiatedEmail = ({ language, firstName, experienceTitle, experienceDate, location, amount, currency }) => {
  const isRo = (language || "en").toLowerCase().startsWith("ro");
  const subject = isRo
    ? `Experiența ta a fost anulată – refund inițiat: ${experienceTitle}`
    : `Your experience was cancelled – refund initiated: ${experienceTitle}`;
  const body = isRo
    ? `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Salut ${firstName},</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Din păcate, experiența „${experienceTitle}”, programată pentru ${experienceDate}, a fost anulată de către host.</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Ce se întâmplă acum:</p>
      <p style="margin:0 0 4px 0;font-size:15px;color:#334155;">– Plata ta a fost anulată</p>
      <p style="margin:0 0 4px 0;font-size:15px;color:#334155;">– Refund-ul a fost inițiat prin Stripe</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">– Banii vor ajunge în contul tău în 3–10 zile lucrătoare, în funcție de bancă</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Detalii rezervare:</p>
      <p style="margin:0 0 4px 0;font-size:15px;color:#334155;">– Experiență: ${experienceTitle}</p>
      <p style="margin:0 0 4px 0;font-size:15px;color:#334155;">– Locație: ${location}</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">– Sumă rambursată: ${amount} ${currency}</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Ne pare rău pentru această situație.<br />Dacă ai întrebări sau ai nevoie de ajutor, ne poți contacta oricând la support@livadai.com.</p>
      <p style="margin:0;font-size:15px;color:#334155;">Cu grijă,<br />Echipa LIVADAI</p>
    `
    : `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Hi ${firstName},</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Unfortunately, the experience “${experienceTitle}”, scheduled for ${experienceDate}, has been cancelled by the host.</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">What happens next:</p>
      <p style="margin:0 0 4px 0;font-size:15px;color:#334155;">– Your payment has been cancelled</p>
      <p style="margin:0 0 4px 0;font-size:15px;color:#334155;">– A refund has been initiated via Stripe</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">– The funds will appear in your account within 3–10 business days, depending on your bank</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Booking details:</p>
      <p style="margin:0 0 4px 0;font-size:15px;color:#334155;">– Experience: ${experienceTitle}</p>
      <p style="margin:0 0 4px 0;font-size:15px;color:#334155;">– Location: ${location}</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">– Refunded amount: ${amount} ${currency}</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">We’re sorry for the inconvenience.<br />If you have any questions or need help, feel free to contact us at support@livadai.com.</p>
      <p style="margin:0;font-size:15px;color:#334155;">Best regards,<br />The LIVADAI Team</p>
    `;
  return { subject, html: body };
};

const buildExperienceCancelledNoticeEmail = ({ language, firstName, experienceTitle, experienceDate, location }) => {
  const isRo = (language || "en").toLowerCase().startsWith("ro");
  const subject = isRo
    ? `Experiența ta a fost anulată: ${experienceTitle}`
    : `Your experience was cancelled: ${experienceTitle}`;
  const body = isRo
    ? `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Salut ${firstName},</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Experiența „${experienceTitle}”, programată pentru ${experienceDate}, a fost anulată de către host.</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Refundul este în curs de procesare.</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Detalii:</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">– Experiență: ${experienceTitle}<br />– Locație: ${location}</p>
      <p style="margin:0;font-size:15px;color:#334155;">Îți mulțumim pentru înțelegere.<br />Dacă ai întrebări, ne poți contacta oricând la support@livadai.com.</p>
    `
    : `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Hi ${firstName},</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">The experience “${experienceTitle}”, scheduled for ${experienceDate}, has been cancelled by the host.</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">The refund is being processed.</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Details:</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">– Experience: ${experienceTitle}<br />– Location: ${location}</p>
      <p style="margin:0;font-size:15px;color:#334155;">Thanks for your understanding.<br />If you have any questions, feel free to contact us at support@livadai.com.</p>
    `;
  return { subject, html: body };
};

const buildRefundCompletedEmail = ({ language, firstName, experienceTitle, amount, currency }) => {
  const isRo = (language || "en").toLowerCase().startsWith("ro");
  const subject = isRo
    ? `Refund finalizat: ${experienceTitle}`
    : `Your refund has been completed: ${experienceTitle}`;
  const body = isRo
    ? `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Salut ${firstName},</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Refund-ul pentru experiența „${experienceTitle}” a fost finalizat cu succes.</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Banii au fost returnați prin Stripe și vor apărea în contul tău în funcție de banca ta (de obicei în 1–3 zile lucrătoare).</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Detalii:</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">– Experiență: ${experienceTitle}<br />– Sumă rambursată: ${amount} ${currency}</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Îți mulțumim pentru răbdare.<br />Dacă ai întrebări, ne poți contacta oricând la support@livadai.com.</p>
      <p style="margin:0;font-size:15px;color:#334155;">Cu grijă,<br />Echipa LIVADAI</p>
    `
    : `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Hi ${firstName},</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">The refund for the experience “${experienceTitle}” has been successfully completed.</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">The funds have been returned via Stripe and will appear in your account depending on your bank (usually within 1–3 business days).</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Details:</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">– Experience: ${experienceTitle}<br />– Refunded amount: ${amount} ${currency}</p>
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">Thank you for your patience.<br />If you have any questions, feel free to contact us at support@livadai.com.</p>
      <p style="margin:0;font-size:15px;color:#334155;">Best regards,<br />The LIVADAI Team</p>
    `;
  return { subject, html: body };
};

const buildMarketingExperienceEmail = ({
  title,
  introText,
  experienceTitle,
  experienceSummary,
  secondaryExperiences,
  ctaLabel,
  ctaUrl,
  unsubscribeUrl,
  testingNotice,
  footerText,
  logoUrl,
}) => {
  const frontendBaseUrl = String(process.env.FRONTEND_URL || process.env.APP_URL || "https://www.livadai.com").replace(/\/$/, "");
  const safeTitle = escapeHtml(title || "Descoperă ceva care merită trăit");
  const safeIntro = introText || "Din când în când, îți trimitem doar ce merită.";
  const safeExperienceTitle = escapeHtml(experienceTitle || "Experiență recomandată");
  const safeExperienceSummary =
    experienceSummary || "Locuri cu suflet, oameni reali și experiențe care rămân cu tine.";
  const secondaryItems = Array.isArray(secondaryExperiences) ? secondaryExperiences.filter(Boolean).slice(0, 2) : [];
  const safeCtaLabel = escapeHtml(ctaLabel || "Descoperă toate experiențele");
  const safeCtaUrl = escapeHtml(ctaUrl || frontendBaseUrl);
  const safeUnsubscribeUrl = unsubscribeUrl ? escapeHtml(unsubscribeUrl) : "";
  const safeLogoUrl = escapeHtml(logoUrl || `${frontendBaseUrl}/email/livadai-logo.png`);
  const safeFooterText = escapeHtml(
    footerText || "Primești acest email pentru că ai ales să primești noutăți LIVADAI. Te poți dezabona oricând."
  );
  const supportEmail = escapeHtml(process.env.SUPPORT_EMAIL || "support@livadai.com");
  const termsUrl = escapeHtml(process.env.TERMS_URL || `${frontendBaseUrl}/terms`);
  const privacyUrl = escapeHtml(process.env.PRIVACY_URL || `${frontendBaseUrl}/privacy`);

  return `
    <div style="margin:0;padding:0;background:#edf7fb;font-family:Arial,'Helvetica Neue',sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#edf7fb;">
        <tr>
          <td align="center" style="padding:28px 12px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;">
              <tr>
                <td style="height:8px;background:${PRIMARY};border-radius:24px 24px 0 0;font-size:0;line-height:0;">&nbsp;</td>
              </tr>
              <tr>
                <td style="background:${SURFACE};border:1px solid #dbeaf0;border-top:0;border-radius:0 0 28px 28px;overflow:hidden;box-shadow:0 18px 40px rgba(15,23,42,0.08);">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                    <tr>
                      <td style="padding:24px 24px 18px;background:${SOFT_SURFACE};border-bottom:1px solid #e2eef4;">
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                          <tr>
                            <td width="72" valign="middle" style="width:72px;padding-right:14px;">
                              <img src="${safeLogoUrl}" alt="LIVADAI" width="58" height="58" style="display:block;width:58px;height:58px;border-radius:18px;border:0;outline:none;text-decoration:none;box-shadow:0 8px 22px rgba(0,188,212,0.18);" />
                            </td>
                            <td valign="middle">
                              <div style="font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#0f6b79;margin-bottom:6px;">Curated by LIVADAI</div>
                              <div style="font-size:28px;line-height:1;font-weight:900;color:${DEEP_TEXT};margin:0;">LIVADAI</div>
                              <div style="font-size:14px;line-height:1.5;color:#0f6b79;margin-top:6px;">Experiențe reale, oameni faini, locuri cu suflet.</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:24px;">
                        ${
                          testingNotice
                            ? `
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;">
                          <tr>
                            <td style="padding:12px 14px;border-radius:16px;background:#f0fdff;border:1px solid #b7edf5;color:${DEEP_TEXT};font-size:13px;line-height:1.6;">
                              ${escapeHtml(testingNotice)}
                            </td>
                          </tr>
                        </table>
                        `
                            : ""
                        }

                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;">
                          <tr>
                            <td style="padding:24px 22px;border-radius:24px;background:${SOFT_SURFACE};border:1px solid #d9eef4;">
                              <div style="font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#0f6b79;margin-bottom:10px;">Selecție LIVADAI</div>
                              <h1 style="margin:0 0 14px 0;font-size:30px;line-height:1.12;font-weight:900;color:${DEEP_TEXT};">${safeTitle}</h1>
                              ${renderPlainTextParagraphs(safeIntro)}
                            </td>
                          </tr>
                        </table>

                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;">
                          <tr>
                            <td style="padding:22px;border-radius:24px;background:${SURFACE};border:1px solid #d7eaef;">
                              <div style="font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:${PRIMARY};margin-bottom:10px;">Experiența principală</div>
                              <div style="font-size:26px;line-height:1.15;font-weight:900;color:${DEEP_TEXT};margin-bottom:10px;">${safeExperienceTitle}</div>
                              ${renderPlainTextParagraphs(safeExperienceSummary, { color: MUTED_TEXT, fontSize: 15, lineHeight: 1.75 })}
                              <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:18px;">
                                <tr>
                                  <td style="border-radius:999px;background:${PRIMARY};">
                                    <a href="${safeCtaUrl}" style="display:inline-block;padding:14px 22px;color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;letter-spacing:0.01em;">${safeCtaLabel}</a>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                        </table>

                        ${
                          secondaryItems.length
                            ? `
                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;">
                          <tr>
                            <td style="padding:0 0 12px 0;font-size:11px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:#64748b;">
                              Mai poți descoperi și
                            </td>
                          </tr>
                          ${secondaryItems
                            .map(
                              (item) => `
                          <tr>
                            <td style="padding:0 0 10px 0;">
                              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                  <td style="padding:16px 18px;border-radius:18px;background:#f8fbfc;border:1px solid #e2edf2;">
                                    <div style="font-size:18px;line-height:1.25;font-weight:800;color:${DEEP_TEXT};margin-bottom:6px;">${escapeHtml(
                                      item.title || "Experiență LIVADAI"
                                    )}</div>
                                    ${
                                      item.summary
                                        ? renderPlainTextParagraphs(item.summary, {
                                            color: MUTED_TEXT,
                                            fontSize: 14,
                                            lineHeight: 1.65,
                                          })
                                        : ""
                                    }
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                          `
                            )
                            .join("")}
                        </table>
                        `
                            : ""
                        }

                        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                          <tr>
                            <td style="padding:18px 18px 16px 18px;border-radius:20px;background:#f8fafc;border:1px solid #e2e8f0;">
                              <div style="font-size:12px;line-height:1.7;color:#64748b;margin-bottom:8px;">${safeFooterText}</div>
                              ${
                                safeUnsubscribeUrl
                                  ? `<div style="font-size:13px;line-height:1.6;color:${DEEP_TEXT};margin-bottom:10px;"><a href="${safeUnsubscribeUrl}" style="color:${PRIMARY};text-decoration:none;font-weight:800;">Dezabonează-te</a></div>`
                                  : ""
                              }
                              <div style="font-size:12px;line-height:1.7;color:#64748b;">
                                Ai întrebări? Scrie-ne la <a href="mailto:${supportEmail}" style="color:${PRIMARY};text-decoration:none;font-weight:700;">${supportEmail}</a>.
                              </div>
                              <div style="font-size:12px;line-height:1.7;color:#94a3b8;margin-top:8px;">
                                <a href="${termsUrl}" style="color:${PRIMARY};text-decoration:none;">Termeni</a>
                                &nbsp;·&nbsp;
                                <a href="${privacyUrl}" style="color:${PRIMARY};text-decoration:none;">Confidențialitate</a>
                              </div>
                            </td>
                          </tr>
                        </table>
                        ${FOOTER_MARKER}
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
};

module.exports = {
  formatExperienceDate,
  formatExperienceLocation,
  buildBilingualSection,
  buildWelcomeEmail,
  buildEmailVerificationEmail,
  buildPasswordResetEmail,
  buildPasswordChangedEmail,
  buildEmailChangedEmail,
  buildAccountDeletedEmail,
  buildDeleteAccountOtpEmail,
  buildBookingConfirmedEmail,
  buildBookingReminderEmail,
  buildBookingCancelledEmail,
  buildAttendanceReminderEmail,
  buildDisputeOpenedEmail,
  buildRefundInitiatedEmail,
  buildExperienceCancelledNoticeEmail,
  buildRefundCompletedEmail,
  buildMarketingExperienceEmail,
};
