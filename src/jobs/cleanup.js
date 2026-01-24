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

// Runs periodically to hide/delete stale experiences.
// Rules:
// - If experience has ended AND has no bookings -> hard delete.
// - If experience has ended AND has bookings -> mark inactive/cancelled.
// - If experience is sold out / no remaining spots -> mark inactive (keep record for bookings).
const setupCleanupJob = () => {
  const run = async () => {
    const now = new Date();
    try {
      const mediaCutoff = new Date(now.getTime() - 72 * 60 * 60 * 1000);
      const mediaTargets = await Experience.find({
        mediaCleanedAt: { $exists: false },
        $and: [
          { $or: [{ endsAt: { $lte: mediaCutoff } }, { endDate: { $lte: mediaCutoff } }] },
          {
            $or: [
              { images: { $exists: true, $ne: [] } },
              { videos: { $exists: true, $ne: [] } },
              { mainImageUrl: { $nin: [null, ""] } },
              { coverImageUrl: { $nin: [null, ""] } },
            ],
          },
        ],
      });

      for (const exp of mediaTargets) {
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
        console.log("Cleanup: removed experience media", { id: exp._id.toString() });
      }

      const ended = await Experience.find({
        isActive: true,
        endsAt: { $lte: now },
      });

      for (const exp of ended) {
        const bookingsCount = await Booking.countDocuments({ experience: exp._id });
        if (bookingsCount === 0) {
          await Experience.deleteOne({ _id: exp._id });
          console.log("Cleanup: deleted expired experience with no bookings", { id: exp._id.toString() });
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
