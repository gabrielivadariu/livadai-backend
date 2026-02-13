const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");
const { deleteCloudinaryUrls } = require("../utils/cloudinary-media");
const { logMediaDeletion } = require("../utils/mediaDeletionLog");

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
      // - If experience has ended AND has bookings -> mark inactive/cancelled.
      // - If experience is sold out / no remaining spots -> mark inactive (keep record for bookings).
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
          exp.isActive = false;
          exp.status = "cancelled";
          exp.soldOut = true;
          exp.remainingSpots = 0;
          const mediaHandled = await removeExperienceMediaIfEligible({
            exp,
            eligibleAt: getExperienceEndDate(exp),
            mediaCutoff,
            activeStatuses,
            reason: "ended-with-bookings",
          });
          if (!mediaHandled) await exp.save();
          console.log("Cleanup: archived expired experience with bookings", { id: exp._id.toString(), bookingsCount });
        }
      }

      // Additional pass for already inactive archived experiences:
      // this catches NO_BOOKINGS / CANCELLED entries that were not eligible
      // at the moment they were archived.
      const inactiveArchived = await Experience.find({
        isActive: false,
        status: { $in: ["NO_BOOKINGS", "CANCELLED", "cancelled"] },
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
