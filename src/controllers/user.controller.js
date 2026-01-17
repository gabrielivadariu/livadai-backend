const mongoose = require("mongoose");
const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");

const buildHistory = async (userId) => {
  const history = await Booking.find({ explorer: userId, status: "COMPLETED" })
    .sort({ updatedAt: -1 })
    .populate({
      path: "experience",
      select: "title startsAt startDate host",
      populate: { path: "host", select: "name profilePhoto avatar displayName" },
    });
  return history.map((h) => ({
    experienceTitle: h.experience?.title,
    date: h.date || h.experience?.startsAt || h.experience?.startDate,
    hostName: h.experience?.host?.displayName || h.experience?.host?.name,
    hostAvatar: h.experience?.host?.profilePhoto || h.experience?.host?.avatar,
    status: h.status,
  }));
};

  const getMeProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select(
      "name displayName avatar age languages shortBio profilePhoto phoneVerified phone isTrustedParticipant city country"
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const completed = await Booking.countDocuments({ explorer: req.user.id, status: "COMPLETED" });
    const noShows = await Booking.countDocuments({ explorer: req.user.id, status: "NO_SHOW" });
    const history = await buildHistory(req.user.id);
    return res.json({
      name: user.displayName || user.name,
      displayName: user.displayName || user.name,
      profilePhoto: user.profilePhoto || user.avatar,
      age: user.age,
      city: user.city,
      country: user.country,
      languages: Array.isArray(user.languages) ? user.languages : [],
      shortBio: user.shortBio,
      phone: user.phone,
      isTrustedParticipant: !!user.isTrustedParticipant,
      experiencesCount: completed,
      noShowCount: noShows,
      phoneVerified: !!user.phoneVerified,
      history,
    });
  } catch (err) {
    console.error("getMeProfile error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

  const updateMeProfile = async (req, res) => {
  try {
    const { age, languages, shortBio, profilePhoto, displayName, phone, city, country } = req.body;
    if (age && (Number(age) < 18 || Number(age) > 99)) {
      return res.status(400).json({ message: "Age must be between 18 and 99" });
    }
    if (shortBio && shortBio.length > 200) {
      return res.status(400).json({ message: "Bio too long" });
    }
    if (displayName !== undefined && !displayName.trim()) {
      return res.status(400).json({ message: "Display name required" });
    }

    const update = {};
    if (age !== undefined) update.age = Number(age);
    if (city !== undefined) update.city = city;
    if (country !== undefined) update.country = country;
    if (languages !== undefined) update.languages = Array.isArray(languages) ? languages : [];
    if (shortBio !== undefined) update.shortBio = shortBio;
    if (profilePhoto !== undefined) {
      if (profilePhoto === "") {
        update.profilePhoto = "";
      } else if (typeof profilePhoto === "string" && /^https?:\/\//i.test(profilePhoto)) {
        update.profilePhoto = profilePhoto;
      }
    }
    if (displayName !== undefined) update.displayName = displayName;
    if (phone !== undefined) update.phone = phone;

    await User.findByIdAndUpdate(req.user.id, update);
    return getMeProfile(req, res);
  } catch (err) {
    console.error("updateMeProfile error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

  const getPublicProfile = async (req, res) => {
  try {
    const userId = req.params.id;
    const user = await User.findById(userId).select(
      "name displayName avatar age languages shortBio profilePhoto phoneVerified isTrustedParticipant city country"
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const completed = await Booking.countDocuments({ explorer: userId, status: "COMPLETED" });
    const noShows = await Booking.countDocuments({ explorer: userId, status: "NO_SHOW" });
    const history = await buildHistory(userId);
    return res.json({
      name: user.displayName || user.name,
      displayName: user.displayName || user.name,
      profilePhoto: user.profilePhoto || user.avatar,
      age: user.age,
      city: user.city,
      country: user.country,
      languages: Array.isArray(user.languages) ? user.languages : [],
      shortBio: user.shortBio,
      isTrustedParticipant: !!user.isTrustedParticipant,
      experiencesCount: completed,
      noShowCount: noShows,
      phoneVerified: !!user.phoneVerified,
      history,
    });
  } catch (err) {
    console.error("getPublicProfile error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const deleteMe = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("role isHost");
    if (!user) return res.status(404).json({ message: "User not found" });

    const isHost = user.isHost || user.role === "HOST" || user.role === "BOTH";
    if (isHost) {
      const now = new Date();
      const activeExpCount = await Experience.countDocuments({
        host: user._id,
        status: "published",
        endsAt: { $gte: now },
      });
      const activeBookingStatuses = ["PENDING", "DEPOSIT_PAID", "PAID", "PENDING_ATTENDANCE", "DISPUTED"];
      const activeBookingCount = await Booking.countDocuments({
        host: user._id,
        status: { $in: activeBookingStatuses },
      });
      if (activeExpCount > 0 || activeBookingCount > 0) {
        return res.status(400).json({
          message: "Nu poți șterge contul cât timp ai experiențe active sau rezervări în desfășurare. / You cannot delete your account while you have active experiences or ongoing bookings.",
        });
      }
    }

    await User.deleteOne({ _id: user._id });
    return res.status(204).send();
  } catch (err) {
    console.error("deleteMe error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getMyFavorites = async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select("favorites")
      .populate({
        path: "favorites",
        select: "title images price city country startsAt startDate address category host rating_avg rating_count",
      });
    if (!user) return res.status(404).json({ message: "User not found" });
    const favorites = (user.favorites || []).filter(Boolean);
    return res.json(favorites);
  } catch (err) {
    console.error("getMyFavorites error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const toggleFavorite = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid experience id" });
    }
    const exp = await Experience.findById(id).select("_id");
    if (!exp) return res.status(404).json({ message: "Experience not found" });

    const user = await User.findById(req.user.id).select("favorites");
    if (!user) return res.status(404).json({ message: "User not found" });

    const already = (user.favorites || []).some((fav) => fav.toString() === id);
    if (already) {
      await User.findByIdAndUpdate(req.user.id, { $pull: { favorites: exp._id } });
      return res.json({ favorite: false });
    }
    await User.findByIdAndUpdate(req.user.id, { $addToSet: { favorites: exp._id } });
    return res.json({ favorite: true });
  } catch (err) {
    console.error("toggleFavorite error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = { getMeProfile, updateMeProfile, getPublicProfile, deleteMe, getMyFavorites, toggleFavorite };
