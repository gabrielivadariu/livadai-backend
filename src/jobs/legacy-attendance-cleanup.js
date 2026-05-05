const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");

const FALLBACK_EXPERIENCE_DURATION_MINUTES = 120;

const toValidDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getExperienceEndDate = (exp, booking) => {
  if (exp) {
    const rawEnd = exp.endsAt || exp.endDate;
    const parsedEnd = toValidDate(rawEnd);
    if (parsedEnd) return parsedEnd;

    const rawStart = exp.startsAt || exp.startDate;
    const parsedStart = toValidDate(rawStart);
    if (parsedStart && exp.durationMinutes) {
      return new Date(parsedStart.getTime() + Number(exp.durationMinutes) * 60 * 1000);
    }
    if (parsedStart) {
      return new Date(parsedStart.getTime() + FALLBACK_EXPERIENCE_DURATION_MINUTES * 60 * 1000);
    }
  }

  if (booking?.createdAt) {
    return new Date(new Date(booking.createdAt).getTime() + 7 * 24 * 60 * 60 * 1000);
  }

  return null;
};

const runLegacyAttendanceCleanup = async () => {
  const now = new Date();

  const legacyBookings = await Booking.find({
    $or: [
      { status: "PENDING_ATTENDANCE" },
      { attendanceStatus: { $exists: true } },
      { attendanceConfirmed: { $exists: true } },
    ],
  })
    .populate("experience", "startsAt startDate endsAt endDate durationMinutes")
    .lean();

  if (!legacyBookings.length) {
    return { scanned: 0, updated: 0, autoCompleted: 0, normalizedToPaid: 0, fieldsRemoved: 0 };
  }

  const experienceIds = Array.from(
    new Set(
      legacyBookings
        .map((booking) => booking.experience?._id?.toString?.() || booking.experience?.toString?.())
        .filter(Boolean)
    )
  );

  const experiences = experienceIds.length
    ? await Experience.find({ _id: { $in: experienceIds } })
        .select("startsAt startDate endsAt endDate durationMinutes")
        .lean()
    : [];

  const experienceMap = new Map(experiences.map((exp) => [String(exp._id), exp]));

  let updated = 0;
  let autoCompleted = 0;
  let normalizedToPaid = 0;
  let fieldsRemoved = 0;

  for (const booking of legacyBookings) {
    const expId = booking.experience?._id?.toString?.() || booking.experience?.toString?.() || "";
    const experience = expId ? experienceMap.get(expId) || booking.experience : booking.experience;
    const endDate = getExperienceEndDate(experience, booking);

    const $set = {};
    const $unset = {};

    if (booking.status === "PENDING_ATTENDANCE") {
      if (endDate && endDate <= now) {
        $set.status = "AUTO_COMPLETED";
        $set.completedAt = booking.completedAt || endDate;
        $set.payoutEligibleAt =
          booking.payoutEligibleAt || new Date(endDate.getTime() + 72 * 60 * 60 * 1000);
        autoCompleted += 1;
      } else {
        $set.status = "PAID";
        normalizedToPaid += 1;
      }
    }

    if (Object.prototype.hasOwnProperty.call(booking, "attendanceStatus")) {
      $unset.attendanceStatus = 1;
      fieldsRemoved += 1;
    }
    if (Object.prototype.hasOwnProperty.call(booking, "attendanceConfirmed")) {
      $unset.attendanceConfirmed = 1;
      fieldsRemoved += 1;
    }

    if (!Object.keys($set).length && !Object.keys($unset).length) continue;

    const update = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    await Booking.updateOne({ _id: booking._id }, update);
    updated += 1;
  }

  return {
    scanned: legacyBookings.length,
    updated,
    autoCompleted,
    normalizedToPaid,
    fieldsRemoved,
  };
};

const setupLegacyAttendanceCleanupJob = async () => {
  try {
    const result = await runLegacyAttendanceCleanup();
    if (result.updated > 0 || result.scanned > 0) {
      console.log("Legacy attendance cleanup completed", result);
    }
  } catch (err) {
    console.error("Legacy attendance cleanup failed", err);
  }
};

module.exports = setupLegacyAttendanceCleanupJob;
