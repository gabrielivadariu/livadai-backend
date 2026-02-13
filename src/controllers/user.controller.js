const mongoose = require("mongoose");
const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const bcrypt = require("bcryptjs");
const { sendEmail } = require("../utils/mailer");
const {
  buildPasswordChangedEmail,
  buildEmailChangedEmail,
  buildAccountDeletedEmail,
  buildDeleteAccountOtpEmail,
} = require("../utils/emailTemplates");
const { validatePasswordStrength } = require("../utils/passwordPolicy");
const { deleteCloudinaryUrls } = require("../utils/cloudinary-media");

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
      "name displayName display_name avatar age languages shortBio profilePhoto phoneVerified phone isTrustedParticipant city country"
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const completed = await Booking.countDocuments({ explorer: req.user.id, status: "COMPLETED" });
    const noShows = await Booking.countDocuments({ explorer: req.user.id, status: "NO_SHOW" });
    const history = await buildHistory(req.user.id);
    const avatar = user.avatar || user.profilePhoto || "";
    const displayName = user.displayName || user.display_name || user.name;
    return res.json({
      name: user.name,
      displayName: displayName || user.name,
      avatar,
      profilePhoto: avatar,
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
    const existingUser = await User.findById(req.user.id).select("avatar profilePhoto");
    if (!existingUser) return res.status(404).json({ message: "User not found" });

    const { age, languages, shortBio, profilePhoto, avatar, displayName, phone, city, country } = req.body;
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
    if (shortBio !== undefined) {
      update.shortBio = shortBio;
      update.about_me = shortBio;
    }
    const incomingAvatar = avatar !== undefined ? avatar : profilePhoto;
    if (incomingAvatar !== undefined) {
      if (incomingAvatar === "") {
        update.avatar = "";
        update.profilePhoto = "";
      } else if (typeof incomingAvatar === "string" && /^https?:\/\//i.test(incomingAvatar)) {
        update.avatar = incomingAvatar;
        update.profilePhoto = incomingAvatar;
      }
    }
    if (displayName !== undefined) {
      update.displayName = displayName;
      update.display_name = displayName;
    }
    if (phone !== undefined) update.phone = phone;

    await User.findByIdAndUpdate(req.user.id, update);

    const avatarChanged = update.avatar !== undefined || update.profilePhoto !== undefined;
    const oldAvatar = existingUser.avatar || existingUser.profilePhoto || "";
    const nextAvatar = update.avatar !== undefined ? update.avatar : update.profilePhoto;
    if (avatarChanged && oldAvatar && oldAvatar !== nextAvatar) {
      await deleteCloudinaryUrls([oldAvatar], {
        scope: "user.profile.avatar-replaced",
      });
    }

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
      "name displayName display_name avatar age languages shortBio profilePhoto phoneVerified isTrustedParticipant city country"
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const completed = await Booking.countDocuments({ explorer: userId, status: "COMPLETED" });
    const noShows = await Booking.countDocuments({ explorer: userId, status: "NO_SHOW" });
    const history = await buildHistory(userId);
    const avatar = user.avatar || user.profilePhoto || "";
    const displayName = user.displayName || user.display_name || user.name;
    return res.json({
      name: user.name,
      displayName: displayName || user.name,
      avatar,
      profilePhoto: avatar,
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

const canDeleteAccount = async (user) => {
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
      return {
        ok: false,
        message:
          "Nu poți șterge contul cât timp ai experiențe active sau rezervări în desfășurare. / You cannot delete your account while you have active experiences or ongoing bookings.",
      };
    }
  }
  return { ok: true };
};

const deleteMe = async (_req, res) => {
  try {
    return res.status(400).json({ message: "Account deletion requires email confirmation." });
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
    const now = new Date();
    const favorites = (user.favorites || []).filter(Boolean);
    const futureFavorites = favorites.filter((exp) => {
      const startValue = exp?.startsAt || exp?.startDate;
      if (!startValue) return false;
      const startDate = new Date(startValue);
      if (Number.isNaN(startDate.getTime())) return false;
      return startDate > now;
    });
    if (futureFavorites.length !== favorites.length) {
      try {
        const keepIds = futureFavorites.map((exp) => exp._id);
        await User.findByIdAndUpdate(req.user.id, { favorites: keepIds });
      } catch (cleanupErr) {
        console.error("favorites cleanup error", cleanupErr);
      }
    }
    return res.json(futureFavorites);
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

const requestDeleteOtp = async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select("email role isHost deleteOtpCode deleteOtpExpires deleteOtpAttempts");
    if (!user) return res.status(404).json({ message: "User not found" });
    const allowed = await canDeleteAccount(user);
    if (!allowed.ok) return res.status(400).json({ message: allowed.message });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    user.deleteOtpCode = otp;
    user.deleteOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
    user.deleteOtpAttempts = 0;
    await user.save();

    try {
      const html = buildDeleteAccountOtpEmail({ code: otp, expiresMinutes: 10 });
      await sendEmail({
        to: user.email,
        subject: "Ștergere cont / Account deletion – LIVADAI",
        html,
        type: "official",
        userId: user._id,
      });
    } catch (err) {
      console.error("Delete OTP email error", err);
    }

    return res.json({ message: "Delete code sent" });
  } catch (err) {
    console.error("requestDeleteOtp error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const confirmDeleteOtp = async (req, res) => {
  try {
    const { otpCode } = req.body || {};
    if (!otpCode) return res.status(400).json({ message: "otpCode required" });
    const user = await User.findById(req.user.id).select("email role isHost deleteOtpCode deleteOtpExpires deleteOtpAttempts");
    if (!user) return res.status(404).json({ message: "User not found" });
    const allowed = await canDeleteAccount(user);
    if (!allowed.ok) return res.status(400).json({ message: allowed.message });

    if (!user.deleteOtpCode || !user.deleteOtpExpires) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }
    if (user.deleteOtpAttempts >= 3) {
      return res.status(400).json({ message: "Too many attempts" });
    }
    if (new Date(user.deleteOtpExpires) < new Date()) {
      return res.status(400).json({ message: "Invalid or expired code" });
    }
    if (user.deleteOtpCode !== otpCode) {
      user.deleteOtpAttempts = (user.deleteOtpAttempts || 0) + 1;
      await user.save();
      return res.status(400).json({ message: "Invalid or expired code" });
    }

    try {
      const html = buildAccountDeletedEmail({});
      await sendEmail({
        to: user.email,
        subject: "Cont șters / Account deleted – LIVADAI",
        html,
        type: "official",
        userId: user._id,
      });
    } catch (err) {
      console.error("Account deleted email error", err);
    }

    await User.deleteOne({ _id: user._id });
    return res.status(204).send();
  } catch (err) {
    console.error("confirmDeleteOtp error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ message: "currentPassword, newPassword, confirmPassword required" });
    }
    if (newPassword !== confirmPassword) return res.status(400).json({ message: "Passwords do not match" });
    const strengthError = validatePasswordStrength(newPassword);
    if (strengthError) return res.status(400).json({ message: strengthError });
    const user = await User.findById(req.user.id).select("password email tokenVersion");
    if (!user) return res.status(404).json({ message: "User not found" });
    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ message: "Invalid credentials" });
    user.password = await bcrypt.hash(newPassword, 10);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    user.lastAuthAt = new Date();
    await user.save();
    try {
      const html = buildPasswordChangedEmail({});
      await sendEmail({
        to: user.email,
        subject: "Parolă schimbată / Password changed – LIVADAI",
        html,
        type: "official",
        userId: user._id,
      });
    } catch (err) {
      console.error("Password changed email error", err);
    }
    return res.json({ message: "Password updated" });
  } catch (err) {
    console.error("changePassword error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const changeEmail = async (req, res) => {
  try {
    const { newEmail } = req.body || {};
    if (!newEmail) return res.status(400).json({ message: "newEmail required" });
    const user = await User.findById(req.user.id).select("email");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.email === newEmail) return res.status(400).json({ message: "Email unchanged" });
    const existing = await User.findOne({ email: newEmail });
    if (existing) return res.status(409).json({ message: "Email already registered" });

    const oldEmail = user.email;
    user.email = newEmail;
    user.lastAuthAt = new Date();
    await user.save();
    try {
      const html = buildEmailChangedEmail({ newEmail });
      await sendEmail({
        to: oldEmail,
        subject: "Email schimbat / Email changed – LIVADAI",
        html,
        type: "official",
        userId: user._id,
      });
      await sendEmail({
        to: newEmail,
        subject: "Email schimbat / Email changed – LIVADAI",
        html,
        type: "official",
        userId: user._id,
      });
    } catch (err) {
      console.error("Email changed email error", err);
    }
    return res.json({ message: "Email updated" });
  } catch (err) {
    console.error("changeEmail error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  getMeProfile,
  updateMeProfile,
  getPublicProfile,
  deleteMe,
  requestDeleteOtp,
  confirmDeleteOtp,
  changePassword,
  changeEmail,
  getMyFavorites,
  toggleFavorite,
};
