const Experience = require("../models/experience.model");
const Booking = require("../models/booking.model");
const Payment = require("../models/payment.model");
const stripe = require("../config/stripe");
const { createNotification } = require("./notifications.controller");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const { sendEmail } = require("../utils/mailer");
const {
  buildBookingCancelledEmail,
  buildRefundInitiatedEmail,
  buildRefundCompletedEmail,
  buildExperienceCancelledNoticeEmail,
  formatExperienceDate,
  formatExperienceLocation,
} = require("../utils/emailTemplates");
const { deleteCloudinaryUrls, getCloudinaryInfo, getTargetKey } = require("../utils/cloudinary-media");
const { logMediaDeletion } = require("../utils/mediaDeletionLog");

const MAX_RECURRING_OCCURRENCES = 240;
const BOOKING_STATUSES_COUNTED = ["PAID", "COMPLETED", "DEPOSIT_PAID", "PENDING_ATTENDANCE"];

const formatDateKey = (dateValue) => {
  const date = toDateSafe(dateValue);
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeExcludedDates = (values) => {
  if (!Array.isArray(values)) return [];
  const unique = new Set();
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const parsed = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) continue;
    unique.add(formatDateKey(parsed));
  }
  return Array.from(unique).sort();
};

const toDateSafe = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
};

const extractExperienceStart = (exp) => exp?.startsAt || exp?.startDate || null;
const extractExperienceEnd = (exp) => exp?.endsAt || exp?.endDate || null;

const isExperiencePublished = (exp) => ["published", "PUBLISHED"].includes(String(exp?.status || ""));
const isExperienceCancelled = (exp) => ["cancelled", "CANCELLED", "DISABLED"].includes(String(exp?.status || ""));

const computeExperienceAvailability = (exp, bookedMap) => {
  const id = exp?._id?.toString?.() || String(exp?._id || "");
  const total = Number(exp?.maxParticipants || 1);
  const booked = Number(bookedMap?.[id] || 0);
  const availableSpots = Math.max(0, total - booked);
  return { bookedSpots: booked, availableSpots };
};

const buildBookedMap = async (experienceIds) => {
  const ids = (experienceIds || []).filter(Boolean);
  if (!ids.length) return {};
  const bookedAgg = await Booking.aggregate([
    { $match: { experience: { $in: ids }, status: { $in: BOOKING_STATUSES_COUNTED } } },
    { $group: { _id: "$experience", booked: { $sum: { $ifNull: ["$quantity", 1] } } } },
  ]);
  return bookedAgg.reduce((acc, row) => {
    acc[row._id.toString()] = row.booked || 0;
    return acc;
  }, {});
};

const aggregateExperiencesBySeries = ({ experiences = [], bookedMap = {}, hostDisplayMap = {} }) => {
  const now = Date.now();
  const groups = new Map();

  for (const exp of experiences) {
    const base = typeof exp.toObject === "function" ? exp.toObject() : { ...exp };
    const stats = computeExperienceAvailability(base, bookedMap);
    const hostId = base.host?._id?.toString?.() || base.host?.toString?.() || String(base.host || "");
    const normalized = {
      ...base,
      ...stats,
      hostDisplayName: hostDisplayMap[hostId] || base.hostDisplayName || "",
    };
    const key = base.scheduleGroupId || String(base._id);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(normalized);
  }

  const result = [];
  for (const [seriesKey, slots] of groups.entries()) {
    const ordered = slots
      .slice()
      .sort((a, b) => (toDateSafe(extractExperienceStart(a))?.getTime() || 0) - (toDateSafe(extractExperienceStart(b))?.getTime() || 0));
    if (!ordered.length) continue;

    const upcoming = ordered.filter((slot) => {
      const startMs = toDateSafe(extractExperienceStart(slot))?.getTime();
      if (!startMs || startMs <= now) return false;
      if (slot.isActive === false) return false;
      if (!isExperiencePublished(slot) || isExperienceCancelled(slot)) return false;
      return true;
    });
    const upcomingBookable = upcoming.filter((slot) => !slot.soldOut && Number(slot.availableSpots || 0) > 0);
    const representative = upcomingBookable[0] || upcoming[0] || ordered[0];
    const firstSlot = ordered[0];
    const lastSlot = ordered[ordered.length - 1];
    const seriesId = representative.scheduleGroupId || null;
    const isSeries = !!seriesId;

    result.push({
      ...representative,
      isSeries,
      seriesId,
      seriesKey,
      seriesSlotsCount: ordered.length,
      seriesAvailableSlots: upcomingBookable.length,
      seriesNextStartsAt: extractExperienceStart(upcoming[0]) || null,
      seriesFirstStartsAt: extractExperienceStart(firstSlot) || null,
      seriesLastEndsAt: extractExperienceEnd(lastSlot) || null,
      seriesRepresentativeId: representative._id,
      scheduleType: isSeries ? "LONG_TERM" : representative.scheduleType || "ONE_TIME",
    });
  }

  return result.sort((a, b) => {
    const aStart = toDateSafe(extractExperienceStart(a))?.getTime() || 0;
    const bStart = toDateSafe(extractExperienceStart(b))?.getTime() || 0;
    return aStart - bStart;
  });
};

const validateSchedule = (payload) => {
  if (!payload.startsAt) {
    return "startsAt is required";
  }
  const start = new Date(payload.startsAt);
  if (Number.isNaN(start.getTime())) {
    return "Invalid date format for startsAt";
  }
  const now = new Date();
  if (start <= now) {
    return "startsAt must be in the future / Data trebuie să fie în viitor";
  }
  let end = payload.endsAt ? new Date(payload.endsAt) : null;
  if (end && Number.isNaN(end.getTime())) {
    return "Invalid date format for endsAt";
  }
  const duration = payload.durationMinutes ? Number(payload.durationMinutes) : null;
  if (!end && duration) {
    if (Number.isNaN(duration) || duration <= 0) {
      return "durationMinutes must be a positive number";
    }
    end = new Date(start.getTime() + duration * 60 * 1000);
  }
  if (!end) {
    return "endsAt or durationMinutes is required";
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

const collectExperienceMediaUrls = (exp) =>
  [
    ...(exp?.images || []),
    ...(exp?.videos || []),
    exp?.mainImageUrl,
    exp?.coverImageUrl,
  ].filter(Boolean);

const buildMediaTargetsFromUrls = (urls) => {
  const refs = [];
  const seen = new Set();
  for (const url of urls || []) {
    const info = getCloudinaryInfo(url);
    if (!info) continue;
    const target = {
      url,
      publicId: info.publicId,
      resourceType: info.resourceType,
    };
    const key = getTargetKey(target);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    refs.push(target);
  }
  return refs;
};

const getExperienceMediaTargets = (exp) => {
  const refs = Array.isArray(exp?.mediaRefs) ? exp.mediaRefs : [];
  if (refs.length) {
    return refs
      .map((ref) => ({
        url: ref?.url,
        publicId: ref?.publicId,
        resourceType: ref?.resourceType || "image",
      }))
      .filter((ref) => !!ref.publicId || !!ref.url);
  }
  return buildMediaTargetsFromUrls(collectExperienceMediaUrls(exp));
};

const normalizeCountryCode = (val) => {
  if (!val) return "";
  const noAccent = val.toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const up = noAccent.trim().toUpperCase();
  if (up.includes("ROMANIA") || up === "RO") return "RO";
  return up;
};

const prepareExperiencePayload = (inputPayload) => {
  const payload = { ...inputPayload };
  const codeRaw =
    payload.countryCode || payload.country || payload.location?.countryCode || payload.location?.country || "";
  const normalizedCode = normalizeCountryCode(codeRaw) || "RO";
  payload.countryCode = normalizedCode;
  if (!payload.country || normalizeCountryCode(payload.country) === "RO") {
    payload.country = "Romania";
  }
  if (payload.countryCode !== "RO") {
    return {
      error:
        "În acest moment poți publica experiențe doar în România. / At the moment, experiences can be published only in Romania.",
      status: 400,
    };
  }

  if (payload.shortDescription && payload.shortDescription.length > 50) {
    return {
      error: "Short description must be at most 50 characters / Descrierea scurtă poate avea maxim 50 de caractere",
      status: 400,
    };
  }

  const scheduleError = validateSchedule(payload);
  if (scheduleError) return { error: scheduleError, status: 400 };

  if (!payload.activityType) payload.activityType = "INDIVIDUAL";
  if (payload.activityType === "INDIVIDUAL") {
    payload.maxParticipants = 1;
    payload.remainingSpots = 1;
  } else if (payload.activityType === "GROUP") {
    const max = Number(payload.maxParticipants) || 1;
    payload.maxParticipants = max;
    payload.remainingSpots = max;
  }

  const pricingModeRaw = String(payload.pricingMode || "").toUpperCase();
  const pricingMode = pricingModeRaw === "PER_GROUP" ? "PER_GROUP" : "PER_PERSON";
  payload.pricingMode = pricingMode;
  if (pricingMode === "PER_GROUP") {
    const fallbackSize = Number(payload.maxParticipants) || 1;
    const packageSize = Math.max(1, Number(payload.groupPackageSize) || fallbackSize);
    payload.groupPackageSize = packageSize;
    if (payload.activityType !== "GROUP") {
      payload.activityType = "GROUP";
      payload.maxParticipants = packageSize;
      payload.remainingSpots = packageSize;
    } else if (payload.maxParticipants < packageSize) {
      payload.maxParticipants = packageSize;
      payload.remainingSpots = packageSize;
    }
  } else {
    payload.groupPackageSize = null;
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
  payload.mediaRefs = buildMediaTargetsFromUrls(collectExperienceMediaUrls(payload));

  if (!payload.languages) payload.languages = [];

  return { payload };
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
    const prepared = prepareExperiencePayload({ ...req.body, host: req.user.id });
    if (prepared.error) return res.status(prepared.status || 400).json({ message: prepared.error });
    const exp = await Experience.create(prepared.payload);
    return res.status(201).json(exp);
  } catch (err) {
    console.error("Create experience error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const createRecurringExperiences = async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id);
    if (currentUser?.isBanned) return res.status(403).json({ message: "Host banned" });
    if (!currentUser?.stripeAccountId) {
      return res
        .status(403)
        .json({ message: "Pentru a crea experiențe, trebuie să îți conectezi și activezi portofelul Stripe." });
    }

    const { occurrences, recurrenceExcludedDates, ...basePayload } = req.body || {};
    if (!Array.isArray(occurrences) || occurrences.length === 0) {
      return res.status(400).json({ message: "occurrences is required and must be a non-empty array" });
    }
    if (occurrences.length > MAX_RECURRING_OCCURRENCES) {
      return res
        .status(400)
        .json({
          message: `Poți crea maximum ${MAX_RECURRING_OCCURRENCES} sloturi dintr-o singură acțiune.`,
        });
    }

    const excludedDateList = normalizeExcludedDates(recurrenceExcludedDates);
    const excludedDateSet = new Set(excludedDateList);
    const normalizedOccurrences = [];
    const seenStarts = new Set();
    for (let index = 0; index < occurrences.length; index += 1) {
      const occurrence = occurrences[index] || {};
      const startsAt = occurrence.startsAt;
      const endsAt = occurrence.endsAt;
      if (!startsAt || !endsAt) {
        return res.status(400).json({ message: `Occurrence ${index + 1} must include startsAt and endsAt` });
      }
      const startsMs = new Date(startsAt).getTime();
      if (!Number.isFinite(startsMs)) {
        return res.status(400).json({ message: `Occurrence ${index + 1} has invalid startsAt` });
      }
      if (seenStarts.has(startsMs)) {
        return res.status(400).json({ message: `Occurrence ${index + 1} duplicates an existing slot` });
      }
      seenStarts.add(startsMs);
      const startDateKey = formatDateKey(startsAt);
      if (!excludedDateSet.has(startDateKey)) {
        normalizedOccurrences.push({
          startsAt,
          endsAt,
          durationMinutes: occurrence.durationMinutes,
        });
      }
    }

    if (!normalizedOccurrences.length) {
      return res.status(400).json({
        message: "Nu există sloturi valabile după aplicarea zilelor indisponibile.",
      });
    }

    const groupId = new mongoose.Types.ObjectId().toString();
    const docs = [];
    for (let index = 0; index < normalizedOccurrences.length; index += 1) {
      const occurrence = normalizedOccurrences[index];
      const prepared = prepareExperiencePayload({
        ...basePayload,
        host: req.user.id,
        startsAt: occurrence.startsAt,
        endsAt: occurrence.endsAt,
        durationMinutes: occurrence.durationMinutes || basePayload.durationMinutes,
        scheduleType: "LONG_TERM",
        scheduleGroupId: groupId,
        recurrenceExcludedDates: excludedDateList,
      });
      if (prepared.error) {
        return res.status(prepared.status || 400).json({ message: `Occurrence ${index + 1}: ${prepared.error}` });
      }
      docs.push(prepared.payload);
    }

    const created = await Experience.insertMany(docs, { ordered: true });
    return res.status(201).json({
      createdCount: created.length,
      scheduleGroupId: groupId,
      recurrenceExcludedDates: excludedDateList,
      experiences: created,
    });
  } catch (err) {
    console.error("Create recurring experiences error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getMyExperiences = async (req, res) => {
  try {
    const exps = await Experience.find({
      host: req.user.id,
      isActive: true,
      status: { $nin: ["DISABLED"] },
    }).sort({ startsAt: 1, createdAt: 1 });
    const bookedMap = await buildBookedMap(exps.map((exp) => exp._id));
    if (String(req.query?.rawSlots || "") === "1") {
      const mapped = exps.map((exp) => ({
        ...exp.toObject(),
        ...computeExperienceAvailability(exp, bookedMap),
      }));
      return res.json(mapped);
    }
    const grouped = aggregateExperiencesBySeries({ experiences: exps, bookedMap });
    return res.json(grouped);
  } catch (err) {
    console.error("Get my experiences error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const updateExperience = async (req, res) => {
  try {
    const currentUser = await User.findById(req.user.id);
    if (currentUser?.isBanned) return res.status(403).json({ message: "Host banned" });
    const existingExp = await Experience.findOne({ _id: req.params.id, host: req.user.id });
    if (!existingExp) return res.status(404).json({ message: "Experience not found" });
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
    if (update.pricingMode !== undefined) {
      update.pricingMode = String(update.pricingMode || "").toUpperCase() === "PER_GROUP" ? "PER_GROUP" : "PER_PERSON";
    }
    if (update.pricingMode === "PER_GROUP") {
      if (!update.activityType) update.activityType = "GROUP";
      const nextGroupPackageSize = Math.max(
        1,
        Number(update.groupPackageSize) || Number(update.maxParticipants) || Number(existingExp.groupPackageSize) || 1
      );
      update.groupPackageSize = nextGroupPackageSize;
      if (update.activityType === "GROUP") {
        const nextMax = Math.max(nextGroupPackageSize, Number(update.maxParticipants) || Number(existingExp.maxParticipants) || 1);
        update.maxParticipants = nextMax;
      }
    }
    if (update.pricingMode === "PER_PERSON") {
      update.groupPackageSize = null;
    }
    if (update.startsAt || update.endsAt || update.durationMinutes) {
      const schedulePayload = {
        startsAt: update.startsAt || update.startDate,
        endsAt: update.endsAt || update.endDate,
        durationMinutes: update.durationMinutes,
      };
      const scheduleError = validateSchedule(schedulePayload);
      if (scheduleError) return res.status(400).json({ message: scheduleError });
      update.startsAt = schedulePayload.startsAt;
      update.endsAt = schedulePayload.endsAt;
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
    // Block price/capacity changes if bookings exist
    const existingBookings = await Booking.findOne({ experience: req.params.id });
    if (existingBookings && update.currencyCode && update.currencyCode !== undefined) {
      return res.status(400).json({ message: "Cannot change currency after bookings exist" });
    }
    if (
      existingBookings &&
      (update.activityType !== undefined ||
        update.maxParticipants !== undefined ||
        update.pricingMode !== undefined ||
        update.groupPackageSize !== undefined)
    ) {
      return res.status(400).json({ message: "Cannot change pricing or participant configuration after bookings exist" });
    }

    const nextActivityType = update.activityType || existingExp.activityType || "INDIVIDUAL";
    if (nextActivityType === "INDIVIDUAL") {
      update.maxParticipants = 1;
      if (!existingBookings) update.remainingSpots = 1;
      if (update.pricingMode === "PER_GROUP") {
        update.activityType = "GROUP";
      }
    } else if (nextActivityType === "GROUP") {
      const max = Math.max(1, Number(update.maxParticipants) || Number(existingExp.maxParticipants) || 1);
      update.maxParticipants = max;
      if (!existingBookings) {
        update.remainingSpots = max;
      }
    }
    if (update.pricingMode === "PER_GROUP") {
      update.activityType = "GROUP";
      const packageSize = Math.max(
        1,
        Number(update.groupPackageSize) || Number(existingExp.groupPackageSize) || Number(update.maxParticipants) || 1
      );
      update.groupPackageSize = packageSize;
      if (!Number(update.maxParticipants) || Number(update.maxParticipants) < packageSize) {
        update.maxParticipants = packageSize;
      }
      if (!existingBookings) {
        update.remainingSpots = Number(update.maxParticipants);
      }
    }

    const mergedMedia = {
      images: update.images !== undefined ? update.images : existingExp.images,
      videos: update.videos !== undefined ? update.videos : existingExp.videos,
      mainImageUrl: update.mainImageUrl !== undefined ? update.mainImageUrl : existingExp.mainImageUrl,
      coverImageUrl: update.coverImageUrl !== undefined ? update.coverImageUrl : existingExp.coverImageUrl,
    };
    update.mediaRefs = buildMediaTargetsFromUrls(collectExperienceMediaUrls(mergedMedia));

    const exp = await Experience.findByIdAndUpdate(existingExp._id, { $set: update }, { new: true });
    if (!exp) return res.status(404).json({ message: "Experience not found" });

    const previousTargets = getExperienceMediaTargets(existingExp);
    const currentKeys = new Set(getExperienceMediaTargets(exp).map((target) => getTargetKey(target)));
    const removedTargets = previousTargets.filter((target) => !currentKeys.has(getTargetKey(target)));
    if (removedTargets.length) {
      const deletedCount = await deleteCloudinaryUrls(removedTargets, {
        scope: "experience.update",
      });
      await logMediaDeletion({
        scope: "experience.update",
        requestedCount: removedTargets.length,
        deletedCount,
        entityType: "experience",
        entityId: exp._id,
        reason: "media-replaced",
      });
    }
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
      const mediaTargets = getExperienceMediaTargets(exp);
      await Experience.deleteOne({ _id: exp._id, host: req.user.id });
      if (mediaTargets.length) {
        const deletedCount = await deleteCloudinaryUrls(mediaTargets, {
          scope: "experience.delete",
        });
        await logMediaDeletion({
          scope: "experience.delete",
          requestedCount: mediaTargets.length,
          deletedCount,
          entityType: "experience",
          entityId: exp._id,
          reason: "delete-without-bookings",
        });
      }
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

const deleteExperienceGroup = async (req, res) => {
  try {
    const groupId = String(req.params.groupId || "").trim();
    if (!groupId) {
      return res.status(400).json({ message: "groupId is required" });
    }
    const currentUser = await User.findById(req.user.id);
    if (currentUser?.isBanned) return res.status(403).json({ message: "Host banned" });

    const experiences = await Experience.find({
      host: req.user.id,
      scheduleGroupId: groupId,
      status: { $nin: ["DISABLED"] },
    });
    if (!experiences.length) {
      return res.status(404).json({ message: "No experiences found for this series" });
    }

    let deletedCount = 0;
    let skippedWithBookings = 0;
    let deletedMediaCount = 0;
    for (const exp of experiences) {
      const hasBookings = await Booking.findOne({ experience: exp._id }).select("_id");
      if (hasBookings) {
        skippedWithBookings += 1;
        continue;
      }
      const mediaTargets = getExperienceMediaTargets(exp);
      await Experience.deleteOne({ _id: exp._id, host: req.user.id });
      deletedCount += 1;
      if (mediaTargets.length) {
        const mediaDeletedForExp = await deleteCloudinaryUrls(mediaTargets, {
          scope: "experience.group-delete",
        });
        deletedMediaCount += mediaDeletedForExp;
        await logMediaDeletion({
          scope: "experience.group-delete",
          requestedCount: mediaTargets.length,
          deletedCount: mediaDeletedForExp,
          entityType: "experience",
          entityId: exp._id,
          reason: "group-delete-without-bookings",
        });
      }
    }

    return res.json({
      success: true,
      groupId,
      total: experiences.length,
      deletedCount,
      skippedWithBookings,
      deletedMediaCount,
    });
  } catch (err) {
    console.error("Delete experience group error", err);
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

    const resolveLanguage = (user) => {
      const langs = Array.isArray(user?.languages) ? user.languages : [];
      const normalized = langs.map((l) => String(l).toLowerCase());
      if (normalized.some((l) => l.startsWith("ro") || l.includes("romanian") || l.includes("română"))) {
        return "ro";
      }
      return "en";
    };

    const getFirstName = (user, language) => {
      const name = user?.displayName || user?.name || "";
      if (!name) return language === "ro" ? "acolo" : "there";
      return name.split(" ")[0] || name;
    };

    const experienceDate = formatExperienceDate(exp);
    const experienceLocation = formatExperienceLocation(exp);

    // Cancel notice + refund flow
    for (const bk of bookings) {
      const explorer = bk.explorer;
      const language = resolveLanguage(explorer);
      const firstName = getFirstName(explorer, language);

      const cancelEmail = buildExperienceCancelledNoticeEmail({
        language,
        firstName,
        experienceTitle: exp.title || "LIVADAI",
        experienceDate,
        location: experienceLocation,
      });
      if (explorer?.email) {
        try {
          await sendEmail({
            to: explorer.email,
            subject: cancelEmail.subject,
            html: cancelEmail.html,
            type: "booking_cancelled",
            userId: explorer?._id,
          });
        } catch (err) {
          console.error("Cancel notice email error", err);
        }
      }

      try {
        const notifTitle = language === "ro" ? "Experiență anulată" : "Experience cancelled";
        const notifMessage =
          language === "ro"
            ? `Experiența ${exp.title ? `„${exp.title}”` : "ta"} a fost anulată de host. Refundul este în curs de procesare.`
            : `The experience ${exp.title ? `“${exp.title}”` : "you booked"} was cancelled by the host. The refund is being processed.`;
        await createNotification({
          user: explorer?._id,
          type: "BOOKING_CANCELLED",
          title: notifTitle,
          message: notifMessage,
          data: { activityId: exp._id, bookingId: bk._id, activityTitle: exp.title },
          push: true,
        });
      } catch (err) {
        console.error("Cancel notice notification error", err);
      }

      if (["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE"].includes(bk.status)) {
        let refunded = false;
        const payments = await Payment.find({ booking: bk._id, status: "CONFIRMED" });
        for (const pay of payments) {
          if (!pay.stripePaymentIntentId) continue;
          try {
            await stripe.refunds.create({
              payment_intent: pay.stripePaymentIntentId,
              refund_application_fee: true,
              reverse_transfer: true,
            });
            pay.status = "REFUNDED";
            await pay.save();
            refunded = true;
          } catch (err) {
            console.error("Refund failed", err.message);
          }
        }
        bk.status = refunded ? "REFUNDED" : "REFUND_FAILED";
        if (refunded) {
          bk.refundedAt = new Date();
        }
        await bk.save();
        if (refunded) {
          const amountMinor = bk.amount || bk.depositAmount || 0;
          const amount = (Number(amountMinor) / 100).toFixed(2);
          const currency = (bk.currency || bk.depositCurrency || "RON").toUpperCase();
          const emailPayload = buildRefundCompletedEmail({
            language,
            firstName,
            experienceTitle: exp.title || "LIVADAI",
            amount,
            currency,
          });
          if (explorer?.email) {
            try {
              await sendEmail({
                to: explorer.email,
                subject: emailPayload.subject,
                html: emailPayload.html,
                type: "booking_cancelled",
                userId: explorer?._id,
              });
            } catch (err) {
              console.error("Refund completed email error", err);
            }
          }

          try {
            const notifTitle = language === "ro" ? "Refund confirmat" : "Refund confirmed";
            const notifMessage =
              language === "ro"
                ? `Refund confirmat pentru experiența ${exp.title ? `„${exp.title}”` : "ta"} – ${amount} ${currency}`
                : `Refund confirmed for the experience ${exp.title ? `“${exp.title}”` : "you booked"} – ${amount} ${currency}`;
            await createNotification({
              user: explorer?._id,
              type: "BOOKING_CANCELLED",
              title: notifTitle,
              message: notifMessage,
              data: { activityId: exp._id, bookingId: bk._id, activityTitle: exp.title },
              push: true,
            });
          } catch (err) {
            console.error("Refund completed notification error", err);
          }
        }
      } else if (!["CANCELLED", "REFUNDED"].includes(bk.status)) {
        bk.status = "CANCELLED";
        bk.cancelledAt = new Date();
        await bk.save();
      }
    }

    exp.status = "CANCELLED";
    exp.isActive = false;
    exp.soldOut = true;
    exp.remainingSpots = 0;
    await exp.save();

    try {
      if (hostUser?.email) {
        const html = buildBookingCancelledEmail({
          experience: exp,
          ctaUrl: exploreUrl,
          role: "host",
        });
        await sendEmail({
          to: hostUser.email,
          subject: `Experiență anulată: ${exp?.title || "LIVADAI"} – ${experienceDate}`,
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
    const exps = await Experience.find(filters).sort({ startsAt: 1, createdAt: 1 });

    const hostIds = Array.from(
      new Set(
        exps
          .map((e) => e.host)
          .filter(Boolean)
          .map((id) => id.toString())
      )
    );
    const hosts = hostIds.length
      ? await User.find({ _id: { $in: hostIds } }).select("name displayName display_name").lean()
      : [];
    const hostMap = hosts.reduce((acc, h) => {
      const displayName = h.displayName || h.display_name || h.name || "";
      acc[h._id.toString()] = displayName;
      return acc;
    }, {});

    const bookedMap = await buildBookedMap(exps.map((exp) => exp._id));
    const mapped = aggregateExperiencesBySeries({
      experiences: exps,
      bookedMap,
      hostDisplayMap: hostMap,
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

    let relatedSlots = [exp];
    if (exp.scheduleGroupId) {
      relatedSlots = await Experience.find({
        host: exp.host?._id || exp.host,
        scheduleGroupId: exp.scheduleGroupId,
        status: { $nin: ["DISABLED"] },
      }).sort({ startsAt: 1, createdAt: 1 });
      if (!relatedSlots.length) relatedSlots = [exp];
    }

    const bookedMap = await buildBookedMap(relatedSlots.map((slot) => slot._id));
    const expStats = computeExperienceAvailability(exp, bookedMap);

    const now = Date.now();
    const slotStats = relatedSlots.map((slotDoc) => {
      const slot = typeof slotDoc.toObject === "function" ? slotDoc.toObject() : { ...slotDoc };
      const stats = computeExperienceAvailability(slot, bookedMap);
      const startMs = toDateSafe(extractExperienceStart(slot))?.getTime() || 0;
      const bookable =
        startMs > now &&
        slot.isActive !== false &&
        isExperiencePublished(slot) &&
        !isExperienceCancelled(slot) &&
        !slot.soldOut &&
        stats.availableSpots > 0;
      return { ...slot, ...stats, bookable };
    });
    const upcomingSlots = slotStats.filter((slot) => {
      const startMs = toDateSafe(extractExperienceStart(slot))?.getTime() || 0;
      return startMs > now;
    });
    const bookableSlots = upcomingSlots.filter((slot) => slot.bookable);

    return res.json({
      ...exp.toObject(),
      ...expStats,
      isSeries: !!exp.scheduleGroupId,
      seriesId: exp.scheduleGroupId || null,
      seriesSlotsCount: slotStats.length,
      seriesAvailableSlots: bookableSlots.length,
      seriesNextStartsAt: extractExperienceStart(upcomingSlots[0]) || null,
      seriesFirstStartsAt: extractExperienceStart(slotStats[0]) || null,
      seriesLastEndsAt: extractExperienceEnd(slotStats[slotStats.length - 1]) || null,
    });
  } catch (err) {
    console.error("Get experience error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getExperienceAvailability = async (req, res) => {
  try {
    const exp = await Experience.findById(req.params.id).select(
      "_id host scheduleGroupId title startsAt endsAt startDate endDate status isActive soldOut maxParticipants remainingSpots pricingMode groupPackageSize activityType price currencyCode"
    );
    if (!exp) return res.status(404).json({ message: "Experience not found" });

    const hostId = exp.host?.toString?.() || String(exp.host || "");
    const role = String(req.user?.role || "").toUpperCase();
    const canViewAllSlots = !!req.user?.id && (req.user.id === hostId || role === "ADMIN" || role === "OWNER_ADMIN");
    const includePast = String(req.query.includePast || "") === "1" || String(req.query.includePast || "") === "true";

    let slots = [exp];
    if (exp.scheduleGroupId) {
      slots = await Experience.find({
        host: exp.host,
        scheduleGroupId: exp.scheduleGroupId,
        status: { $nin: ["DISABLED"] },
      })
        .select(
          "_id host scheduleGroupId title startsAt endsAt startDate endDate status isActive soldOut maxParticipants remainingSpots pricingMode groupPackageSize activityType price currencyCode city country address"
        )
        .sort({ startsAt: 1, createdAt: 1 });
      if (!slots.length) slots = [exp];
    }

    const now = Date.now();
    const bookedMap = await buildBookedMap(slots.map((slot) => slot._id));
    const mapped = slots
      .map((slotDoc) => {
        const slot = typeof slotDoc.toObject === "function" ? slotDoc.toObject() : { ...slotDoc };
        const stats = computeExperienceAvailability(slot, bookedMap);
        const startMs = toDateSafe(extractExperienceStart(slot))?.getTime() || 0;
        const isPublished = isExperiencePublished(slot);
        const isCancelled = isExperienceCancelled(slot);
        const visible = canViewAllSlots ? true : slot.isActive !== false && isPublished && !isCancelled;
        const bookable = visible && startMs > now && !slot.soldOut && stats.availableSpots > 0;
        return {
          ...slot,
          ...stats,
          startMs,
          visible,
          bookable,
        };
      })
      .filter((slot) => slot.visible)
      .filter((slot) => includePast || slot.startMs > now)
      .map((slot) => {
        const { startMs, visible, ...rest } = slot;
        return rest;
      });

    return res.json({
      experienceId: exp._id,
      isSeries: !!exp.scheduleGroupId,
      seriesId: exp.scheduleGroupId || null,
      pricingMode: exp.pricingMode || "PER_PERSON",
      groupPackageSize: exp.groupPackageSize || null,
      slots: mapped,
    });
  } catch (err) {
    console.error("Get experience availability error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

const getExperiencesMap = async (req, res) => {
  try {
    const now = new Date();
    const exps = await Experience.find({
      isActive: true,
      soldOut: { $ne: true },
      status: "published",
      startsAt: { $gt: now },
      latitude: { $nin: [null, 0] },
      longitude: { $nin: [null, 0] },
    })
      .select(
        "title shortDescription description category price pricingMode groupPackageSize latitude longitude activityType remainingSpots maxParticipants soldOut startsAt startDate endsAt endDate scheduleGroupId host"
      )
      .populate("host", "profilePhoto avatar hostProfile.avatar");

    const bookedMap = await buildBookedMap(exps.map((exp) => exp._id));
    const grouped = aggregateExperiencesBySeries({ experiences: exps, bookedMap });
    const mapped = grouped.map((exp) => {
      const host = exp.host || {};
      const profileImage =
        [host.profilePhoto, host.avatar, host.hostProfile?.avatar].find(
          (value) => typeof value === "string" && /^https?:\/\//i.test(value)
        ) || "";
      return { ...exp, host: { ...host, profileImage } };
    });

    return res.json(mapped);
  } catch (err) {
    console.error("Map experiences error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createExperience,
  createRecurringExperiences,
  getMyExperiences,
  updateExperience,
  deleteExperience,
  deleteExperienceGroup,
  listExperiences,
  getExperienceById,
  getExperienceAvailability,
  getExperiencesMap,
  cancelExperience,
};
