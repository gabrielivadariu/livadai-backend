const User = require("../models/user.model");
const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");
const Review = require("../models/review.model");
const { Types } = require("mongoose");
const { deleteCloudinaryUrls, getCloudinaryInfo } = require("../utils/cloudinary-media");
const { logMediaDeletion } = require("../utils/mediaDeletionLog");

const bookingStatusesForStats = new Set([
  "PAID",
  "DEPOSIT_PAID",
  "PENDING_ATTENDANCE",
  "COMPLETED",
  "AUTO_COMPLETED",
  "NO_SHOW",
  "DISPUTED",
  "DISPUTE_WON",
  "DISPUTE_LOST",
]);
const reviewAllowedBookingStatuses = new Set(["COMPLETED", "AUTO_COMPLETED", "PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE", "CONFIRMED"]);
const FALLBACK_EXPERIENCE_DURATION_MINUTES = 120;
const bookingStatusesForAvailability = ["PAID", "COMPLETED", "DEPOSIT_PAID", "PENDING_ATTENDANCE"];

const toDateSafe = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const extractExperienceStart = (exp) => exp?.startsAt || exp?.startDate || null;

const getExperienceEndDate = (exp) => {
  if (!exp) return null;
  const rawEnd = exp?.endsAt || exp?.endDate;
  if (rawEnd) {
    const endDate = new Date(rawEnd);
    if (!Number.isNaN(endDate.getTime())) return endDate;
  }
  const rawStart = exp?.startsAt || exp?.startDate;
  if (rawStart && exp?.durationMinutes) {
    const startDate = new Date(rawStart);
    if (!Number.isNaN(startDate.getTime())) {
      return new Date(startDate.getTime() + Number(exp.durationMinutes) * 60 * 1000);
    }
  }
  if (rawStart) {
    const startDate = new Date(rawStart);
    if (!Number.isNaN(startDate.getTime())) {
      return new Date(startDate.getTime() + FALLBACK_EXPERIENCE_DURATION_MINUTES * 60 * 1000);
    }
  }
  return null;
};

const computeHostStats = async (hostId) => {
  const now = new Date();
  const hostExperiences = await Experience.find({
    host: hostId,
  })
    .select("_id endsAt")
    .lean();

  const hostExperienceIds = hostExperiences.map((exp) => exp._id).filter(Boolean);

  // Evenimente finalizate = experiențe ale gazdei care au trecut de final.
  const totalEvents = hostExperiences.filter((exp) => {
    const end = toDateSafe(exp.endsAt);
    return end && end < now;
  }).length;

  // Participanți = locuri rezervate pentru experiențe ale gazdei care au generat
  // participare reală sau sunt în stadiile finale normale după încheiere.
  // Folosim și experience ids ca fallback pentru booking-uri vechi unde `host`
  // poate lipsi sau poate fi inconsistent.
  const agg = await Booking.aggregate([
    {
      $match: {
        status: { $in: Array.from(bookingStatusesForStats) },
        $or: [{ host: new Types.ObjectId(hostId) }, { experience: { $in: hostExperienceIds } }],
      },
    },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$quantity", 1] } } } },
  ]);
  const totalParticipants = agg[0]?.total || 0;
  return { totalEvents, totalParticipants };
};

const getHostProfile = async (req, res) => {
  try {
    let { id } = req.params;
    if (id === "me") {
      if (!req.user?.id) return res.status(401).json({ message: "Authentication required" });
      id = req.user.id;
    }
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid host id" });
    }
    const user = await User.findById(id).select(
      "name displayName display_name role city country languages about_me age avatar phone rating_avg rating_count total_participants total_events experience"
    );
    if (!user || user.role !== "HOST") return res.status(404).json({ message: "Host not found" });
    const viewerId = req.user?.id;
    let phone = "";
    let canViewPhone = false;
    if (viewerId === id) {
      phone = user.phone || "";
      canViewPhone = true;
    } else if (viewerId) {
      const allowedStatuses = new Set(["PAID", "COMPLETED", "DEPOSIT_PAID", "PENDING_ATTENDANCE"]);
      const booking = await Booking.findOne({
        host: id,
        explorer: viewerId,
        status: { $in: Array.from(allowedStatuses) },
      }).select("_id status");
      if (booking) {
        phone = user.phone || "";
        canViewPhone = true;
      }
    }
    const stats = await computeHostStats(id);

    // Basic fallback values
    const displayName = user.displayName || user.display_name || user.name;
    return res.json({
      id: user._id,
      name: user.name,
      displayName: displayName || user.name,
      display_name: displayName || user.name,
      age: user.age || null,
      city: user.city || "",
      country: user.country || "",
      languages: Array.isArray(user.languages)
        ? user.languages
        : typeof user.languages === "string" && user.languages.trim()
        ? user.languages
            .split(/[;,\\s]+/)
            .map((l) => l.toUpperCase())
            .filter(Boolean)
        : [],
      about_me: user.about_me || "",
      rating_avg: user.rating_avg || 0,
      rating_count: user.rating_count || 0,
      total_participants: stats.totalParticipants ?? user.total_participants ?? 0,
      total_events: stats.totalEvents ?? user.total_events ?? 0,
      avatar: user.avatar || "",
      phone: canViewPhone ? phone || undefined : undefined,
      canViewPhone,
      experience: user.experience || "",
      experienceDescription: user.experience || "",
    });
  } catch (err) {
    console.error("getHostProfile error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getMyHostProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "name displayName display_name city country languages about_me age avatar phone role rating_avg rating_count total_participants total_events experience"
    );
    if (!user || user.role !== "HOST") return res.status(404).json({ message: "Host not found" });
    const stats = await computeHostStats(req.user.id);
    const displayName = user.displayName || user.display_name || user.name;
    return res.json({
      ...user.toObject(),
      displayName: displayName || user.name,
      display_name: displayName || user.name,
      total_participants: stats.totalParticipants ?? user.total_participants ?? 0,
      total_events: stats.totalEvents ?? user.total_events ?? 0,
    });
  } catch (err) {
    console.error("getMyHostProfile error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getHostReviews = async (_req, res) => {
  try {
    const { id } = _req.params;
    const reviews = await Review.find({ host: id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("user", "name");
    return res.json(
      reviews.map((r) => ({
        _id: r._id,
        rating: r.rating,
        comment: r.comment,
        createdAt: r.createdAt,
        author: r.user ? { _id: r.user._id, name: r.user.name } : null,
      }))
    );
  } catch (err) {
    console.error("getHostReviews error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getHostActivities = async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.max(1, Number(req.query.limit) || 200);
    const includeSlots = String(req.query.includeSlots || "") === "1" || String(req.query.rawSlots || "") === "1";
    const activities = await Experience.find({ host: id, status: { $nin: ["DISABLED"] } })
      .sort({ startsAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();
    const ids = activities.map((a) => a._id).filter(Boolean);
    if (!ids.length) return res.json([]);
    const bookedAgg = await Booking.aggregate([
      { $match: { experience: { $in: ids }, status: { $in: bookingStatusesForAvailability } } },
      { $group: { _id: "$experience", booked: { $sum: { $ifNull: ["$quantity", 1] } } } },
    ]);
    const bookedMap = bookedAgg.reduce((acc, row) => {
      acc[row._id.toString()] = row.booked || 0;
      return acc;
    }, {});
    const withStats = activities.map((exp) => {
      const total = Number(exp.maxParticipants || 1);
      const booked = Number(bookedMap[exp._id.toString()] || 0);
      const availableSpots = Math.max(0, total - booked);
      return { ...exp, bookedSpots: booked, availableSpots };
    });
    if (includeSlots) {
      return res.json(withStats);
    }

    const groups = new Map();
    for (const exp of withStats) {
      const key = exp.scheduleGroupId || String(exp._id);
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(exp);
    }
    const now = Date.now();
    const grouped = [];
    for (const [seriesKey, slots] of groups.entries()) {
      const ordered = slots
        .slice()
        .sort(
          (a, b) =>
            (toDateSafe(extractExperienceStart(a))?.getTime() || 0) - (toDateSafe(extractExperienceStart(b))?.getTime() || 0)
        );
      if (!ordered.length) continue;
      const upcoming = ordered.filter((slot) => (toDateSafe(extractExperienceStart(slot))?.getTime() || 0) > now);
      const upcomingBookable = upcoming.filter(
        (slot) =>
          slot.isActive !== false &&
          ["published", "PUBLISHED"].includes(String(slot.status || "")) &&
          !["cancelled", "CANCELLED"].includes(String(slot.status || "")) &&
          !slot.soldOut &&
          Number(slot.availableSpots || 0) > 0
      );
      const representative = upcomingBookable[0] || upcoming[0] || ordered[0];
      grouped.push({
        ...representative,
        isSeries: !!representative.scheduleGroupId,
        seriesId: representative.scheduleGroupId || null,
        seriesKey,
        seriesSlotsCount: ordered.length,
        seriesAvailableSlots: upcomingBookable.length,
        seriesNextStartsAt: extractExperienceStart(upcoming[0]) || null,
        seriesFirstStartsAt: extractExperienceStart(ordered[0]) || null,
        seriesLastEndsAt: ordered[ordered.length - 1]?.endsAt || ordered[ordered.length - 1]?.endDate || null,
      });
    }

    grouped.sort(
      (a, b) => (toDateSafe(extractExperienceStart(b))?.getTime() || 0) - (toDateSafe(extractExperienceStart(a))?.getTime() || 0)
    );
    return res.json(grouped);
  } catch (err) {
    console.error("getHostActivities error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const updateMyProfile = async (req, res) => {
  try {
    const existingUser = await User.findById(req.user.id).select("avatar profilePhoto avatarPublicId avatarResourceType");
    if (!existingUser) return res.status(404).json({ message: "User not found" });

    const allowed = [
      "display_name",
      "displayName",
      "name",
      "city",
      "country",
      "languages",
      "about_me",
      "age",
      "avatar",
      "phone",
      "experience",
      "experienceDescription",
    ];
    const update = {};
    allowed.forEach((f) => {
      if (req.body[f] !== undefined) update[f] = req.body[f];
    });
    if (update.avatar !== undefined) {
      if (update.avatar === "") {
        // allow clearing
        update.avatarPublicId = null;
        update.avatarResourceType = null;
      } else if (typeof update.avatar === "string" && /^https?:\/\//i.test(update.avatar)) {
        // keep as-is
        const avatarInfo = getCloudinaryInfo(update.avatar);
        update.avatarPublicId = avatarInfo?.publicId || null;
        update.avatarResourceType = avatarInfo?.resourceType || null;
      } else {
        delete update.avatar;
      }
    }
    if (update.avatar !== undefined) {
      update.profilePhoto = update.avatar;
    }
    // normalize experience description to single field
    if (update.experienceDescription && !update.experience) {
      update.experience = update.experienceDescription;
    }
    if (update.experience && !update.experienceDescription) {
      update.experienceDescription = update.experience;
    }
    const userUpdate = {};
    if (update.displayName !== undefined) {
      update.display_name = update.displayName;
    }
    if (update.display_name !== undefined) {
      userUpdate.displayName = update.display_name;
      userUpdate.display_name = update.display_name;
    }
    if (update.name !== undefined) userUpdate.name = update.name;
    if (update.city !== undefined) userUpdate.city = update.city;
    if (update.country !== undefined) userUpdate.country = update.country;
    if (update.languages !== undefined) userUpdate.languages = update.languages;
    if (update.age !== undefined) userUpdate.age = update.age;
    if (update.phone !== undefined) userUpdate.phone = update.phone;
    if (update.about_me !== undefined) {
      userUpdate.about_me = update.about_me;
      userUpdate.shortBio = update.about_me;
    }
    if (update.avatar !== undefined) {
      userUpdate.avatar = update.avatar;
      userUpdate.profilePhoto = update.avatar;
      userUpdate.avatarPublicId = update.avatarPublicId;
      userUpdate.avatarResourceType = update.avatarResourceType;
    }
    if (update.experience !== undefined) userUpdate.experience = update.experience;

    if (Object.keys(userUpdate).length) {
      await User.findByIdAndUpdate(req.user.id, userUpdate);
    }

    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select(
      "name displayName display_name city country languages about_me age avatar phone experience"
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const avatarChanged = update.avatar !== undefined;
    const oldAvatar = existingUser.avatar || existingUser.profilePhoto || "";
    const nextAvatar = update.avatar;
    if (avatarChanged && oldAvatar && oldAvatar !== nextAvatar) {
      const oldAvatarTarget = existingUser.avatarPublicId
        ? {
            url: oldAvatar,
            publicId: existingUser.avatarPublicId,
            resourceType: existingUser.avatarResourceType || "image",
          }
        : oldAvatar;
      const deletedCount = await deleteCloudinaryUrls([oldAvatarTarget], {
        scope: "host.profile.avatar-replaced",
      });
      await logMediaDeletion({
        scope: "host.profile.avatar-replaced",
        requestedCount: 1,
        deletedCount,
        entityType: "host",
        entityId: req.user.id,
        reason: "avatar-replaced",
      });
    }

    const displayName = user.displayName || user.display_name || user.name;
    return res.json({
      ...user.toObject(),
      displayName: displayName || user.name,
      display_name: displayName || user.name,
    });
  } catch (err) {
    console.error("updateMyProfile error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const addHostReview = async (req, res) => {
  try {
    const { id } = req.params; // hostId
    const { experienceId, bookingId, rating, comment } = req.body;
    if (!experienceId || !bookingId || !rating) {
      return res.status(400).json({ message: "experienceId, bookingId and rating required" });
    }
    const host = await User.findById(id);
    if (!host || !["HOST", "BOTH"].includes(String(host.role || "").toUpperCase())) {
      return res.status(404).json({ message: "Host not found" });
    }

    const booking = await Booking.findOne({
      _id: bookingId,
      experience: experienceId,
      host: id,
      explorer: req.user.id,
      status: { $in: Array.from(reviewAllowedBookingStatuses) },
    }).populate("experience", "endsAt endDate startsAt startDate durationMinutes");
    if (!booking) {
      return res.status(403).json({ message: "Cannot review without an eligible booking." });
    }

    const existing = await Review.findOne({ booking: bookingId, user: req.user.id });
    if (existing) {
      return res.status(409).json({ message: "Review already submitted for this booking." });
    }

    const exp = booking.experience;
    const endDate = getExperienceEndDate(exp);
    if (!endDate || Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ message: "Experience end date missing." });
    }
    const now = new Date();
    if (now <= endDate) {
      return res.status(400).json({ message: "Reviews are available after the experience ends." });
    }

    const review = await Review.create({
      host: id,
      experience: experienceId,
      booking: bookingId,
      user: req.user.id,
      rating,
      comment,
    });

    // Recompute host rating
    const agg = await Review.aggregate([
      { $match: { host: host._id } },
      { $group: { _id: "$host", avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ]);
    const stats = agg[0];
    if (stats) {
      host.rating_avg = stats.avg || 0;
      host.rating_count = stats.count || 0;
      await host.save();
    }

    return res.status(201).json(review);
  } catch (err) {
    console.error("addHostReview error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getHostProfile, getMyHostProfile, getHostReviews, getHostActivities, updateMyProfile, addHostReview };
