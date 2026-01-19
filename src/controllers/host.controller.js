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
      .limit(limit);
    return res.json(activities);
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
    if (!experienceId || !rating) return res.status(400).json({ message: "experienceId and rating required" });
    const host = await User.findById(id);
    if (!host || host.role !== "HOST") return res.status(404).json({ message: "Host not found" });

    const allowedStatuses = new Set(["PAID", "COMPLETED", "DEPOSIT_PAID"]);
    const booking = await Booking.findOne({
      _id: bookingId,
      experience: experienceId,
      host: id,
      explorer: req.user.id,
      status: { $in: Array.from(allowedStatuses) },
    });
    if (!booking) return res.status(403).json({ message: "Cannot review without a completed/paid booking." });

    const review = await Review.findOneAndUpdate(
      { host: id, experience: experienceId, user: req.user.id },
      { rating, comment },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

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
