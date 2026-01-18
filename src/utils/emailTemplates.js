const { buildBrandedEmail } = require("./mailer");

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

const buildBookingCancelledEmail = ({ experience, bookingId, ctaUrl }) => {
  const dateLabel = formatExperienceDate(experience);
  return buildBrandedEmail({
    title: "Experiență anulată",
    intro: `Experiența "${experience?.title || "LIVADAI"}" a fost anulată.`,
    bodyHtml: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Dată:</strong> ${dateLabel}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Motiv:</strong> Experiența a fost anulată.</p>
      ${bookingId ? `<p style="margin:0;font-size:15px;color:#334155;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
    ctaLabel: "Vezi experiențe similare",
    ctaUrl,
  });
};

const buildBookingReminderEmail = ({ experience, bookingId, ctaUrl }) => {
  const dateLabel = formatExperienceDate(experience);
  const locationLabel = formatExperienceLocation(experience);
  return buildBrandedEmail({
    title: "Reminder: experiența ta începe în 24h",
    intro: `Ne vedem curând la "${experience?.title || "LIVADAI"}".`,
    bodyHtml: `
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Dată:</strong> ${dateLabel}</p>
      <p style="margin:0 0 6px 0;font-size:15px;color:#334155;"><strong>Locație:</strong> ${locationLabel}</p>
      ${bookingId ? `<p style="margin:0;font-size:15px;color:#334155;"><strong>Booking ID:</strong> ${bookingId}</p>` : ""}
    `,
    ctaLabel: "Vezi bookingul",
    ctaUrl,
  });
};

module.exports = {
  formatExperienceDate,
  formatExperienceLocation,
  buildBookingCancelledEmail,
  buildBookingReminderEmail,
};
