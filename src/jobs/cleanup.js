const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");
const cloudinary = require("cloudinary").v2;

const isRealValue = (v) => v && v !== "dummy";

const hasCloudinary =
  isRealValue(process.env.CLOUDINARY_CLOUD_NAME) &&
  isRealValue(process.env.CLOUDINARY_API_KEY) &&
  isRealValue(process.env.CLOUDINARY_API_SECRET);

if (hasCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const getCloudinaryInfo = (url) => {
  if (!url || typeof url !== "string") return null;
  if (!url.includes("res.cloudinary.com") || !url.includes("/upload/")) return null;
  const resourceType = url.includes("/video/upload/")
    ? "video"
    : url.includes("/raw/upload/")
      ? "raw"
      : "image";
  const parts = url.split("/upload/");
  if (parts.length < 2) return null;
  let publicPath = parts[1].split("?")[0];
  const versionSplit = publicPath.split(/\/v\d+\//);
  if (versionSplit.length > 1) {
    publicPath = versionSplit[versionSplit.length - 1];
  }
  publicPath = publicPath.replace(/\.[^/.]+$/, "");
  if (!publicPath) return null;
  return { publicId: publicPath, resourceType };
};

const deleteCloudinaryMedia = async (urls) => {
  if (!hasCloudinary) return;
  const unique = Array.from(new Set(urls.filter(Boolean)));
  for (const url of unique) {
    const info = getCloudinaryInfo(url);
    if (!info) continue;
    try {
      await cloudinary.uploader.destroy(info.publicId, { resource_type: info.resourceType });
    } catch (err) {
      console.error("Cleanup: failed to delete Cloudinary asset", { url, err: err?.message || err });
    }
  }
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
      const closedStatuses = ["COMPLETED", "CANCELLED", "REFUNDED", "AUTO_COMPLETED", "NO_SHOW", "DISPUTE_WON", "DISPUTE_LOST"];
      const activeStatuses = ["PENDING", "PAID", "DEPOSIT_PAID", "CONFIRMED", "PENDING_ATTENDANCE", "DISPUTED"];
      const closedBookings = await Booking.find({
        status: { $in: closedStatuses },
      }).populate(
        "experience",
        "endsAt endDate startsAt startDate durationMinutes images videos mainImageUrl coverImageUrl mediaCleanedAt"
      );

      for (const booking of closedBookings) {
        const exp = booking.experience;
        if (!exp || exp.mediaCleanedAt) continue;

        const hasMedia =
          (exp.images && exp.images.length) ||
          (exp.videos && exp.videos.length) ||
          exp.mainImageUrl ||
          exp.coverImageUrl;
        if (!hasMedia) {
          exp.mediaCleanedAt = new Date();
          await exp.save();
          continue;
        }

        let eligibleAt = null;
        if (["COMPLETED", "AUTO_COMPLETED", "NO_SHOW"].includes(booking.status)) {
          eligibleAt = getExperienceEndDate(exp);
        } else if (booking.status === "CANCELLED") {
          eligibleAt = booking.cancelledAt || booking.updatedAt || booking.createdAt;
        } else if (booking.status === "REFUNDED") {
          eligibleAt = booking.refundedAt || booking.updatedAt || booking.createdAt;
        }

        if (!eligibleAt || eligibleAt > mediaCutoff) continue;

        const activeExists = await Booking.exists({
          experience: exp._id,
          status: { $in: activeStatuses },
        });
        if (activeExists) continue;

        const urls = [
          ...(exp.images || []),
          ...(exp.videos || []),
          exp.mainImageUrl,
          exp.coverImageUrl,
        ];
        await deleteCloudinaryMedia(urls);
        exp.images = [];
        exp.videos = [];
        exp.mainImageUrl = null;
        exp.coverImageUrl = null;
        exp.mediaCleanedAt = new Date();
        await exp.save();
        console.log("Cleanup: removed experience media", { id: exp._id.toString(), booking: booking._id.toString() });
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
          if (!exp.mediaCleanedAt) {
            const eligibleAt = getExperienceEndDate(exp);
            if (eligibleAt && eligibleAt <= mediaCutoff) {
              const urls = [
                ...(exp.images || []),
                ...(exp.videos || []),
                exp.mainImageUrl,
                exp.coverImageUrl,
              ];
              await deleteCloudinaryMedia(urls);
              exp.images = [];
              exp.videos = [];
              exp.mainImageUrl = null;
              exp.coverImageUrl = null;
              exp.mediaCleanedAt = new Date();
            }
          }
          await exp.save();
          console.log("Cleanup: archived expired experience with no bookings", { id: exp._id.toString() });
        } else {
          exp.isActive = false;
          exp.status = "cancelled";
          exp.soldOut = true;
          exp.remainingSpots = 0;
          await exp.save();
          console.log("Cleanup: archived expired experience with bookings", { id: exp._id.toString(), bookingsCount });
        }
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
