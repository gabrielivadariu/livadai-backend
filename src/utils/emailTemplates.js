const { buildBrandedEmail } = require("./mailer");
const PRIMARY = "#00bcd4";
const ACCENT = "#16a34a";

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
    intro: "Îți mulțumim că ai ales LIVADAI.",
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

const buildBookingConfirmedEmail = ({ experience, bookingId, ctaUrl, role }) => {
  const dateLabel = formatExperienceDate(experience);
  const locationLabel = formatExperienceLocation(experience);
  const title = role === "host" ? "Rezervare confirmată / Booking confirmed" : "Booking confirmat / Booking confirmed";
  const intro =
    role === "host"
      ? "Ai primit o rezervare nouă."
      : "Rezervarea ta este confirmată.";
  const bodyHtml = buildBilingualSection({
    roTitle: "Detalii esențiale",
    roBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Experiență:</strong> ${experience?.title || "LIVADAI"}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Dată:</strong> ${dateLabel}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Locație:</strong> ${locationLabel}</p>
      ${bookingId ? `<p style="margin:0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
    enTitle: "Key details",
    enBody: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Experience:</strong> ${experience?.title || "LIVADAI"}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Date:</strong> ${dateLabel}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Location:</strong> ${locationLabel}</p>
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
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;">Plata va fi returnată conform politicii de refund.</p>
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
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">A fost deschisă o dispută pentru bookingul "${experience?.title || "LIVADAI"}".</p>
      <p style="margin:0;font-size:15px;color:#334155;">Vom analiza situația și te vom anunța pașii următori.</p>
      ${bookingId ? `<p style="margin:10px 0 0 0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
    enTitle: "Dispute opened",
    enBody: `
      <p style="margin:0 0 10px 0;font-size:15px;color:#334155;">A dispute has been opened for "${experience?.title || "LIVADAI"}".</p>
      <p style="margin:0;font-size:15px;color:#334155;">We will review the case and follow up with next steps.</p>
      ${bookingId ? `<p style="margin:10px 0 0 0;font-size:13px;color:#64748b;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
  });
  return buildBrandedEmail({
    title: "Dispută / Dispute",
    intro: "Notificare importantă.",
    bodyHtml,
  });
};

module.exports = {
  formatExperienceDate,
  formatExperienceLocation,
  buildBilingualSection,
  buildWelcomeEmail,
  buildEmailVerificationEmail,
  buildPasswordResetEmail,
  buildBookingConfirmedEmail,
  buildBookingReminderEmail,
  buildBookingCancelledEmail,
  buildAttendanceReminderEmail,
  buildDisputeOpenedEmail,
};
