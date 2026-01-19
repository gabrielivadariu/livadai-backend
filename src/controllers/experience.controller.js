const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const stripe = require("../config/stripe");
const { createNotification } = require("./notifications.controller");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const { sendEmail } = require("../utils/mailer");
const { buildBookingCancelledEmail } = require("../utils/emailTemplates");

const validateSchedule = (payload) => {
  if (!payload.startsAt || !payload.endsAt) {
    return "startsAt and endsAt are required";
  }
  const start = new Date(payload.startsAt);
  const end = new Date(payload.endsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Invalid date format for startsAt/endsAt";
  }
  if (end < start) {
    return "endsAt must be after startsAt";
  }
  payload.startsAt = start;
  payload.endsAt = end;
  // keep legacy fields populated for compatibility
  payload.startDate = start;
  payload.endDate = end;
  payload.startTime = start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  payload.endTime = end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return null;
};

const createExperience = async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id);
    if (currentUser?.isBanned) return res.status(403).json({ message: "Host banned" });
    if (!currentUser?.stripeAccountId) {
      return res
        .status(403)
        .json({ message: "Pentru a crea experiențe, trebuie să îți conectezi și activezi portofelul Stripe." });
    }
    const payload = { ...req.body, host: req.user.id };
    // normalize country code
    const normalizeCode = (val) => {
      if (!val) return "";
      const noAccent = val.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const up = noAccent.trim().toUpperCase();
      if (up.includes("ROMANIA") || up === "RO") return "RO";
      return up;
    };
    const codeRaw =
      payload.countryCode || payload.country || payload.location?.countryCode || payload.location?.country || "";
    const normalizedCode = normalizeCode(codeRaw) || "RO";
    payload.countryCode = normalizedCode;
    if (!payload.country || normalizeCode(payload.country) === "RO") {
      payload.country = "Romania";
    }
    if (payload.countryCode !== "RO") {
      return res
        .status(400)
        .json({
          message:
            "În acest moment poți publica experiențe doar în România. / At the moment, experiences can be published only in Romania.",
        });
    }

    if (payload.shortDescription && payload.shortDescription.length > 50) {
      return res
        .status(400)
        .json({ message: "Short description must be at most 50 characters / Descrierea scurtă poate avea maxim 50 de caractere" });
    }
    const scheduleError = validateSchedule(payload);
    if (scheduleError) return res.status(400).json({ message: scheduleError });

    // Defaults for activity type and capacity
    if (!payload.activityType) payload.activityType = "INDIVIDUAL";
    if (payload.activityType === "INDIVIDUAL") {
      payload.maxParticipants = 1;
      payload.remainingSpots = 1;
    } else if (payload.activityType === "GROUP") {
      const max = Number(payload.maxParticipants) || 1;
      payload.maxParticipants = max;
      payload.remainingSpots = max;
    }

    payload.currencyCode = "RON";
    if (!payload.status) payload.status = "published";

    if (!payload.description && payload.longDescription) {
      payload.description = payload.longDescription;
    }

    if (!payload.address) {
      if (payload.location?.formattedAddress) {
        payload.address = payload.location.formattedAddress;
      } else {
        const addressParts = [payload.street, payload.streetNumber, payload.city, payload.country].filter(Boolean);
        payload.address = addressParts.join(", ");
      }
    }

    if (payload.locationLat) payload.latitude = payload.locationLat;
    if (payload.locationLng) payload.longitude = payload.locationLng;
    if (payload.location?.lat) payload.latitude = payload.location.lat;
    if (payload.location?.lng) payload.longitude = payload.location.lng;

    if (payload.images?.length && !payload.mainImageUrl) {
      payload.mainImageUrl = payload.images[0];
    }

    if (!payload.languages) payload.languages = [];

    const exp = await Experience.create(payload);
    return res.status(201).json(exp);
  } catch (err) {
    console.error("Create experience error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getMyExperiences = async (req, res) => {
  try {
    const exps = await Experience.find({
      host: req.user.id,
      isActive: true,
      status: { $nin: ["DISABLED"] },
    });
    return res.json(exps);
  } catch (err) {
    console.error("Get my experiences error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const updateExperience = async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id);
    if (currentUser?.isBanned) return res.status(403).json({ message: "Host banned" });
    const update = { ...req.body };
    if (update.country || update.countryCode) {
      const codeRaw = update.countryCode || update.country;
      const normalizedCode = codeRaw ? codeRaw.toString().trim().toUpperCase().replace("ROMANIA", "RO") : "RO";
      if (normalizedCode !== "RO") {
        return res
          .status(400)
          .json({ message: "În acest moment poți publica experiențe doar în România. / At the moment, experiences can be published only in Romania." });
      }
      update.countryCode = "RO";
      if (!update.country || update.country.toUpperCase() === "RO") {
        update.country = "Romania";
      }
    }
    if (update.country && update.country !== "RO") {
      return res.status(400).json({ message: "În acest moment poți publica experiențe doar în România. / At the moment, experiences can be published only in Romania." });
    }
    if (update.shortDescription && update.shortDescription.length > 50) {
      return res
        .status(400)
        .json({ message: "Short description must be at most 50 characters / Descrierea scurtă poate avea maxim 50 de caractere" });
    }
    if (update.currencyCode && update.currencyCode !== "RON") {
      update.currencyCode = "RON";
    }
    if (update.startsAt || update.endsAt) {
      const scheduleError = validateSchedule({
        startsAt: update.startsAt || update.startDate,
        endsAt: update.endsAt || update.endDate,
      });
      if (scheduleError) return res.status(400).json({ message: scheduleError });
      update.startsAt = new Date(update.startsAt || update.startDate);
      update.endsAt = new Date(update.endsAt || update.endDate);
      update.startDate = update.startsAt;
      update.endDate = update.endsAt;
      update.startTime = update.startsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      update.endTime = update.endsAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (!update.status) update.status = "published";
    if (update.currencyCode && update.currencyCode !== "RON") {
      update.currencyCode = "RON";
    }
    if (update.locationLat) update.latitude = update.locationLat;
    if (update.locationLng) update.longitude = update.locationLng;
    // Block currency change if bookings exist
    const existingBookings = await Booking.findOne({ experience: req.params.id });
    if (existingBookings && update.currencyCode && update.currencyCode !== undefined) {
      return res.status(400).json({ message: "Cannot change currency after bookings exist" });
    }

    const exp = await Experience.findOneAndUpdate({ _id: req.params.id, host: req.user.id }, { $set: update }, { new: true });
    if (!exp) return res.status(404).json({ message: "Experience not found" });
    return res.json(exp);
  } catch (err) {
    console.error("Update experience error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const deleteExperience = async (req, res) => {
  try {
    const exp = await Experience.findOne({ _id: req.params.id, host: req.user.id });
    const currentUser = await User.findById(req.user.id);
    if (currentUser?.isBanned) return res.status(403).json({ message: "Host banned" });
    if (!exp) return res.status(404).json({ message: "Experience not found" });

    const hasBookings = await Booking.findOne({ experience: exp._id });

    if (!hasBookings) {
      await Experience.deleteOne({ _id: exp._id, host: req.user.id });
      return res.json({ success: true, status: "deleted" });
    }

    exp.status = "cancelled";
    exp.isActive = false;
    exp.soldOut = true;
    exp.remainingSpots = 0;
    await exp.save();
    return res.json({ success: true, status: "cancelled" });
  } catch (err) {
    console.error("Delete experience error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const cancelExperience = async (req, res) => {
  try {
    const exp = await Experience.findOne({ _id: req.params.id, host: req.user.id });
    if (!exp) return res.status(404).json({ message: "Experience not found" });

    const bookings = await Booking.find({ experience: exp._id }).populate("explorer", "email name displayName");
    const hostUser = await User.findById(exp.host).select("email name displayName");
    const appUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
    const exploreUrl = `${appUrl.replace(/\/$/, "")}/experiences`;

    // Refund paid bookings and notify explorers
    for (const bk of bookings) {
      if (["PAID", "DEPOSIT_PAID"].includes(bk.status)) {
        const payments = await Payment.find({ booking: bk._id, status: "CONFIRMED" });
        for (const pay of payments) {
          if (pay.stripePaymentIntentId) {
            try {
              await stripe.refunds.create({ payment_intent: pay.stripePaymentIntentId });
              pay.status = "REFUNDED";
              await pay.save();
            } catch (err) {
              console.error("Refund failed", err.message);
            }
          }
        }
      }
      bk.status = "CANCELLED";
      await bk.save();
      try {
        await createNotification({
          user: bk.explorer,
          type: "BOOKING_CANCELLED",
          title: "Booking cancelled",
          message: `Your booking for "${exp.title}" was cancelled by the host.`,
          data: { activityId: exp._id, bookingId: bk._id, activityTitle: exp.title },
        });
      } catch (err) {
        console.error("Notify cancel booking error", err);
      }

      try {
        const explorer = bk.explorer;
        if (explorer?.email) {
          const html = buildBookingCancelledEmail({
            experience: exp,
            bookingId: bk._id,
            ctaUrl: exploreUrl,
          });
          await sendEmail({
            to: explorer.email,
            subject: "Experiență anulată",
            html,
            type: "booking_cancelled",
            userId: explorer._id,
          });
        }
      } catch (err) {
        console.error("Cancel booking email error", err);
      }
    }

    exp.status = "cancelled";
    exp.isActive = false;
    exp.soldOut = true;
    exp.remainingSpots = 0;
    await exp.save();

    try {
      if (hostUser?.email) {
        const html = buildBookingCancelledEmail({
          experience: exp,
          ctaUrl: exploreUrl,
        });
        await sendEmail({
          to: hostUser.email,
          subject: "Experiență anulată",
          html,
          type: "booking_cancelled",
          userId: hostUser._id,
        });
      }
    } catch (err) {
      console.error("Cancel experience host email error", err);
    }

    return res.json({ success: true, status: "cancelled" });
  } catch (err) {
    console.error("Cancel experience error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const listExperiences = async (req, res) => {
  try {
    const { category, minPrice, maxPrice } = req.query;
    const now = new Date();
    const filters = {
      isActive: true,
      soldOut: { $ne: true },
      status: { $in: ["published", "PUBLISHED"] },
      startsAt: { $gt: now },
    };
    if (category) filters.category = category;
    if (minPrice || maxPrice) {
      filters.price = {};
      if (minPrice) filters.price.$gte = Number(minPrice);
      if (maxPrice) filters.price.$lte = Number(maxPrice);
    }
    const exps = await Experience.find(filters);

    // Compute booked spots for these experiences
    const ids = exps.map((e) => e._id);
    const bookedAgg = await Booking.aggregate([
      { $match: { experience: { $in: ids }, status: { $in: ["PAID", "COMPLETED"] } } },
      { $group: { _id: "$experience", booked: { $sum: { $ifNull: ["$quantity", 1] } } } },
    ]);
    const bookedMap = bookedAgg.reduce((acc, b) => {
      acc[b._id.toString()] = b.booked || 0;
      return acc;
    }, {});

    const mapped = exps.map((e) => {
      const total = e.maxParticipants || 1;
      const booked = bookedMap[e._id.toString()] || 0;
      const availableSpots = Math.max(0, total - booked);
      return { ...e.toObject(), bookedSpots: booked, availableSpots };
    });

    return res.json(mapped);
  } catch (err) {
    console.error("List experiences error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getExperienceById = async (req, res) => {
  try {
    const exp = await Experience.findById(req.params.id).populate(
      "host",
      "name displayName profilePhoto avatar"
    );
    if (!exp) return res.status(404).json({ message: "Experience not found" });

    const isDisabled = exp.isActive === false || exp.status === "DISABLED";
    if (isDisabled) {
      if (req.user?.id) {
        const allowedStatuses = ["PAID", "DEPOSIT_PAID", "COMPLETED", "PENDING_ATTENDANCE"];
        const hasBooking = await Booking.findOne({
          experience: exp._id,
          status: { $in: allowedStatuses },
          $or: [{ explorer: req.user.id }, { host: req.user.id }],
        }).select("_id");
        if (hasBooking) {
          return res.json(exp.toObject());
        }
      }
      return res.status(404).json({ message: "Experience not found" });
    }

    const bookedAgg = await Booking.aggregate([
      {
        $match: {
          experience: new mongoose.Types.ObjectId(exp._id),
          status: { $in: ["PAID", "COMPLETED"] },
        },
      },
      { $group: { _id: "$experience", booked: { $sum: { $ifNull: ["$quantity", 1] } } } },
    ]);
    const booked = bookedAgg?.[0]?.booked || 0;
    const total = exp.maxParticipants || 1;
    const availableSpots = Math.max(0, total - booked);

    return res.json({ ...exp.toObject(), bookedSpots: booked, availableSpots });
  } catch (err) {
    console.error("Get experience error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getExperiencesMap = async (req, res) => {
  try {
    const exps = await Experience.find({
      isActive: true,
      soldOut: { $ne: true },
      status: "published",
      latitude: { $nin: [null, 0] },
      longitude: { $nin: [null, 0] },
    })
      .select("title shortDescription description category price latitude longitude activityType remainingSpots host")
      .populate("host", "profilePhoto avatar hostProfile.avatar");

    const mapped = exps.map((exp) => {
      const obj = exp.toObject();
      const host = obj.host || {};
      const profileImage =
        [host.profilePhoto, host.avatar, host.hostProfile?.avatar].find(
          (value) => typeof value === "string" && /^https?:\/\//i.test(value)
        ) || "";
      return { ...obj, host: { ...host, profileImage } };
    });

    return res.json(mapped);
  } catch (err) {
    console.error("Map experiences error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createExperience,
  getMyExperiences,
  updateExperience,
  deleteExperience,
  listExperiences,
  getExperienceById,
  getExperiencesMap,
  cancelExperience,
};
