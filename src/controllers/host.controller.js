const User = require("../models/user.model");
const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");
const Review = require("../models/review.model");

const bookingStatusesForStats = new Set(["PAID", "COMPLETED", "DEPOSIT_PAID"]);

const computeHostStats = async (hostId) => {
  const now = new Date();
  // Evenimente finalizate = experiențe care au trecut
  const totalEvents = await Experience.countDocuments({
    host: hostId,
    endsAt: { $lt: now },
  });
  const agg = await Booking.aggregate([
    { $match: { host: hostId, status: { $in: Array.from(bookingStatusesForStats) } } },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$quantity", 1] } } } },
  ]);
  const totalParticipants = agg[0]?.total || 0;
  return { totalEvents, totalParticipants };
};

const getHostProfile = async (req, res) => {
  try {
    let { id } = req.params;
    if (id === "me" && req.user?.id) id = req.user.id;
    const user = await User.findById(id).select(
      "name role city country languages about_me display_name age avatar phone rating_avg rating_count total_participants total_events experience"
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
    return res.json({
      id: user._id,
      display_name: user.display_name || user.name,
      name: user.name,
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
      "name display_name city country languages about_me age avatar phone role rating_avg rating_count total_participants total_events experience"
    );
    if (!user || user.role !== "HOST") return res.status(404).json({ message: "Host not found" });
    const stats = await computeHostStats(req.user.id);
    return res.json({
      ...user.toObject(),
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
    const limit = Number(req.query.limit) || 10;
    const activities = await Experience.find({ host: id })
      .sort({ startDate: -1, createdAt: -1 })
      .limit(limit)
      .lean();
    const ids = activities.map((a) => a._id);
    if (!ids.length) return res.json([]);
    const bookedAgg = await Booking.aggregate([
      { $match: { experience: { $in: ids }, status: { $nin: ["CANCELLED", "REFUNDED"] } } },
      { $group: { _id: "$experience", booked: { $sum: { $ifNull: ["$quantity", 1] } } } },
    ]);
    const bookedMap = bookedAgg.reduce((acc, b) => {
      acc[b._id.toString()] = b.booked || 0;
      return acc;
    }, {});
    const payload = activities.map((exp) => {
      const total = exp.maxParticipants || 1;
      const booked = bookedMap[exp._id.toString()] || 0;
      const availableSpots = Math.max(0, total - booked);
      return { ...exp, bookedSpots: booked, availableSpots };
    });
    return res.json(payload);
  } catch (err) {
    console.error("getHostActivities error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const updateMyProfile = async (req, res) => {
  try {
    const allowed = [
      "display_name",
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
      } else if (typeof update.avatar === "string" && /^https?:\/\//i.test(update.avatar)) {
        // keep as-is
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
    }
    if (update.experience !== undefined) userUpdate.experience = update.experience;

    if (Object.keys(userUpdate).length) {
      await User.findByIdAndUpdate(req.user.id, userUpdate);
    }

    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true }).select(
      "name display_name city country languages about_me age avatar phone experience"
    );
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.json(user);
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
    if (!host || host.role !== "HOST") return res.status(404).json({ message: "Host not found" });

    const booking = await Booking.findOne({
      _id: bookingId,
      experience: experienceId,
      host: id,
      explorer: req.user.id,
      status: "COMPLETED",
    }).populate("experience", "endsAt endDate startsAt startDate durationMinutes");
    if (!booking) {
      return res.status(403).json({ message: "Cannot review without a completed booking." });
    }

    const existing = await Review.findOne({ booking: bookingId, user: req.user.id });
    if (existing) {
      return res.status(409).json({ message: "Review already submitted for this booking." });
    }

    const exp = booking.experience;
    const rawEnd = exp?.endsAt || exp?.endDate;
    let endDate = rawEnd ? new Date(rawEnd) : null;
    if (!endDate && exp?.startsAt && exp?.durationMinutes) {
      const startDate = new Date(exp.startsAt);
      if (!Number.isNaN(startDate.getTime())) {
        endDate = new Date(startDate.getTime() + Number(exp.durationMinutes) * 60 * 1000);
      }
    }
    if (!endDate && exp?.startDate && exp?.durationMinutes) {
      const startDate = new Date(exp.startDate);
      if (!Number.isNaN(startDate.getTime())) {
        endDate = new Date(startDate.getTime() + Number(exp.durationMinutes) * 60 * 1000);
      }
    }
    if (!endDate && exp?.startsAt) {
      const startDate = new Date(exp.startsAt);
      if (!Number.isNaN(startDate.getTime())) {
        endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      }
    }
    if (!endDate && exp?.startDate) {
      const startDate = new Date(exp.startDate);
      if (!Number.isNaN(startDate.getTime())) {
        endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      }
    }
    if (!endDate || Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ message: "Experience end date missing." });
    }
    const reviewOpenAt = new Date(endDate.getTime() + 48 * 60 * 60 * 1000);
    if (new Date() <= reviewOpenAt) {
      return res.status(400).json({ message: "Reviews are available 48h after the experience ends." });
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
