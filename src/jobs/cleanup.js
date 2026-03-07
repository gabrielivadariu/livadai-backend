const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");
const { deleteCloudinaryUrls } = require("../utils/cloudinary-media");
const { logMediaDeletion } = require("../utils/mediaDeletionLog");

const CANCELLATION_BOOKING_STATUSES = new Set(["CANCELLED", "REFUNDED", "REFUND_FAILED"]);
const OCCUPIED_BOOKING_STATUSES = [
  "PAID",
  "DEPOSIT_PAID",
  "PENDING_ATTENDANCE",
  "COMPLETED",
  "AUTO_COMPLETED",
  "NO_SHOW",
  "DISPUTED",
  "DISPUTE_WON",
  "DISPUTE_LOST",
];

const normalizeStatus = (value) => String(value || "").toUpperCase().trim();

const isCancellationOnlyFlow = (statuses) => {
  if (!Array.isArray(statuses) || statuses.length === 0) return false;
  return statuses.every((status) => CANCELLATION_BOOKING_STATUSES.has(status));
};

const getExperienceBookingStatuses = async (experienceId) => {
  const statuses = await Booking.distinct("status", { experience: experienceId });
  return statuses.map(normalizeStatus).filter(Boolean);
};

const recomputeExperienceAvailability = async ({ experienceId, maxParticipants }) => {
  const total = Math.max(1, Number(maxParticipants || 1));
  const occupiedAgg = await Booking.aggregate([
    {
      $match: {
        experience: experienceId,
        status: { $in: OCCUPIED_BOOKING_STATUSES },
      },
    },
    {
      $group: {
        _id: "$experience",
        occupied: { $sum: { $ifNull: ["$quantity", 1] } },
      },
    },
  ]);
  const occupied = Number(occupiedAgg?.[0]?.occupied || 0);
  const remainingSpots = Math.max(0, total - occupied);
  return {
    occupied,
    remainingSpots,
    soldOut: remainingSpots <= 0,
  };
};

const getExperienceEndDate = (exp) => {
  if (!exp) return null;
  const rawEnd = exp.endsAt || exp.endDate;
  if (rawEnd) {
    const endDate = new Date(rawEnd);
    if (!Number.isNaN(endDate.getTime())) return endDate;
  }
  const rawStart = exp.startsAt || exp.startDate;
  if (rawStart && exp.durationMinutes) {
    const startDate = new Date(rawStart);
    if (!Number.isNaN(startDate.getTime())) {
      return new Date(startDate.getTime() + Number(exp.durationMinutes) * 60 * 1000);
    }
  }
  if (rawStart) {
    const startDate = new Date(rawStart);
    if (!Number.isNaN(startDate.getTime())) {
      return new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  return null;
};

const hasMedia = (exp) =>
  !!(
    (exp.mediaRefs && exp.mediaRefs.length) ||
    (exp.images && exp.images.length) ||
    (exp.videos && exp.videos.length) ||
    exp.mainImageUrl ||
    exp.coverImageUrl
  );

const getExperienceMediaTargets = (exp) => {
  if (Array.isArray(exp.mediaRefs) && exp.mediaRefs.length) {
    return exp.mediaRefs
      .map((ref) => ({
        url: ref?.url,
        publicId: ref?.publicId,
        resourceType: ref?.resourceType || "image",
      }))
      .filter((ref) => !!ref.publicId || !!ref.url);
  }
  return [
    ...(exp.images || []),
    ...(exp.videos || []),
    exp.mainImageUrl,
    exp.coverImageUrl,
  ].filter(Boolean);
};

const clearExperienceMedia = (exp) => {
  exp.mediaRefs = [];
  exp.images = [];
  exp.videos = [];
  exp.mainImageUrl = null;
  exp.coverImageUrl = null;
  exp.mediaCleanedAt = new Date();
};

const removeExperienceMediaIfEligible = async ({
  exp,
  eligibleAt,
  mediaCutoff,
  activeStatuses,
  reason,
}) => {
  if (!exp || exp.mediaCleanedAt) return false;

  if (!hasMedia(exp)) {
    exp.mediaCleanedAt = new Date();
    await exp.save();
    return true;
  }

  if (!eligibleAt || eligibleAt > mediaCutoff) return false;

  const activeExists = await Booking.exists({
    experience: exp._id,
    status: { $in: activeStatuses },
  });
  if (activeExists) return false;

  const targets = getExperienceMediaTargets(exp);
  const deletedCount = await deleteCloudinaryUrls(targets, {
    scope: `cleanup:${reason || "unknown"}`,
  });
  await logMediaDeletion({
    scope: `cleanup:${reason || "unknown"}`,
    requestedCount: targets.length,
    deletedCount,
    entityType: "experience",
    entityId: exp._id,
    reason,
  });
  clearExperienceMedia(exp);
  await exp.save();
  console.log("Cleanup: removed experience media", {
    id: exp._id.toString(),
    reason: reason || "unknown",
  });
  return true;
};

// Runs periodically to hide/delete stale experiences.
// Rules:
// - If experience has ended AND has no bookings -> archive (read-only history).
// - If experience has ended AND has bookings -> mark inactive/archived (not cancelled).
// - If experience is sold out / no remaining spots -> mark sold out.
const setupCleanupJob = () => {
  const run = async () => {
    const now = new Date();
    try {
      const mediaCutoff = new Date(now.getTime() - 72 * 60 * 60 * 1000);
      const closedStatuses = ["COMPLETED", "CANCELLED", "REFUNDED", "REFUND_FAILED", "AUTO_COMPLETED", "NO_SHOW", "DISPUTE_WON", "DISPUTE_LOST"];
      const activeStatuses = ["PENDING", "PAID", "DEPOSIT_PAID", "CONFIRMED", "PENDING_ATTENDANCE", "DISPUTED"];
      const closedBookings = await Booking.find({
        status: { $in: closedStatuses },
      }).populate(
        "experience",
        "endsAt endDate startsAt startDate durationMinutes mediaRefs images videos mainImageUrl coverImageUrl mediaCleanedAt"
      );

      for (const booking of closedBookings) {
        const exp = booking.experience;
        if (!exp || exp.mediaCleanedAt) continue;

        let eligibleAt = null;
        if (["COMPLETED", "AUTO_COMPLETED", "NO_SHOW"].includes(booking.status)) {
          eligibleAt = getExperienceEndDate(exp);
        } else if (booking.status === "CANCELLED") {
          eligibleAt = booking.cancelledAt || booking.updatedAt || booking.createdAt;
        } else if (booking.status === "REFUNDED") {
          eligibleAt = booking.refundedAt || booking.updatedAt || booking.createdAt;
        }
        await removeExperienceMediaIfEligible({
          exp,
          eligibleAt,
          mediaCutoff,
          activeStatuses,
          reason: `closed-booking:${booking.status.toLowerCase()}`,
        });
      }

      const ended = await Experience.find({
        isActive: true,
        endsAt: { $lte: now },
      });

      for (const exp of ended) {
        const bookingsCount = await Booking.countDocuments({ experience: exp._id });
        if (bookingsCount === 0) {
          exp.isActive = false;
          exp.status = "NO_BOOKINGS";
          const mediaHandled = await removeExperienceMediaIfEligible({
            exp,
            eligibleAt: getExperienceEndDate(exp),
            mediaCutoff,
            activeStatuses,
            reason: "ended-no-bookings",
          });
          if (!mediaHandled) await exp.save();
          console.log("Cleanup: archived expired experience with no bookings", { id: exp._id.toString() });
        } else {
          const bookingStatuses = await getExperienceBookingStatuses(exp._id);
          const cancelledByHostFlow = isCancellationOnlyFlow(bookingStatuses);
          exp.isActive = false;
          if (cancelledByHostFlow) {
            exp.status = "CANCELLED";
            exp.soldOut = true;
            exp.remainingSpots = 0;
          } else {
            exp.status = "ARCHIVED";
            const availability = await recomputeExperienceAvailability({
              experienceId: exp._id,
              maxParticipants: exp.maxParticipants,
            });
            exp.remainingSpots = availability.remainingSpots;
            exp.soldOut = availability.soldOut;
          }
          const mediaHandled = await removeExperienceMediaIfEligible({
            exp,
            eligibleAt: getExperienceEndDate(exp),
            mediaCutoff,
            activeStatuses,
            reason: cancelledByHostFlow ? "ended-with-cancelled-bookings" : "ended-with-bookings",
          });
          if (!mediaHandled) await exp.save();
          console.log("Cleanup: archived expired experience with bookings", {
            id: exp._id.toString(),
            bookingsCount,
            status: exp.status,
          });
        }
      }

      // Repair old wrong states: previously-ended experiences with bookings were marked as cancelled.
      const potentiallyWrongCancelled = await Experience.find({
        isActive: false,
        status: { $in: ["cancelled", "CANCELLED"] },
      }).select("_id status endsAt endDate startsAt startDate durationMinutes maxParticipants soldOut remainingSpots");

      for (const exp of potentiallyWrongCancelled) {
        const endedAt = getExperienceEndDate(exp);
        if (!endedAt || endedAt > now) continue;
        const bookingStatuses = await getExperienceBookingStatuses(exp._id);
        if (!bookingStatuses.length || isCancellationOnlyFlow(bookingStatuses)) continue;

        const availability = await recomputeExperienceAvailability({
          experienceId: exp._id,
          maxParticipants: exp.maxParticipants,
        });
        const previousStatus = exp.status;
        exp.status = "ARCHIVED";
        exp.remainingSpots = availability.remainingSpots;
        exp.soldOut = availability.soldOut;
        await exp.save();
        console.log("Cleanup: fixed wrongly-cancelled experience status", {
          id: exp._id.toString(),
          from: previousStatus,
          to: exp.status,
        });
      }

      // Additional pass for already inactive archived experiences:
      // this catches NO_BOOKINGS / CANCELLED / ARCHIVED entries that were not eligible
      // at the moment they were archived.
      const inactiveArchived = await Experience.find({
        isActive: false,
        status: { $in: ["NO_BOOKINGS", "CANCELLED", "cancelled", "ARCHIVED"] },
        $or: [{ mediaCleanedAt: { $exists: false } }, { mediaCleanedAt: null }],
      }).select("status endsAt endDate startsAt startDate durationMinutes mediaRefs images videos mainImageUrl coverImageUrl mediaCleanedAt updatedAt");

      for (const exp of inactiveArchived) {
        const eligibleAt =
          exp.status === "NO_BOOKINGS"
            ? getExperienceEndDate(exp)
            : exp.updatedAt || getExperienceEndDate(exp);
        await removeExperienceMediaIfEligible({
          exp,
          eligibleAt,
          mediaCutoff,
          activeStatuses,
          reason: `inactive-${String(exp.status || "").toLowerCase() || "unknown"}`,
        });
      }

      const soldOut = await Experience.updateMany(
        {
          $or: [{ soldOut: true }, { remainingSpots: { $lte: 0 } }],
        },
        {
          $set: { soldOut: true, remainingSpots: 0 },
        }
      );
      if (soldOut.modifiedCount) {
        console.log("Cleanup: marked sold-out experiences", { count: soldOut.modifiedCount });
      }
    } catch (err) {
      console.error("Cleanup job error", err);
    }
  };

  // Run every 15 minutes
  setInterval(run, 15 * 60 * 1000);
  // Run once on startup
  run();
};

module.exports = setupCleanupJob;
