const { Router } = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/user.model");
const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const Report = require("../models/report.model");
const Payment = require("../models/payment.model");
const Message = require("../models/message.model");
const MediaDeletionLog = require("../models/mediaDeletionLog.model");
const AdminAuditLog = require("../models/adminAuditLog.model");
const HostComplianceSnapshot = require("../models/hostComplianceSnapshot.model");
const { deleteCloudinaryUrls, getCloudinaryInfo } = require("../utils/cloudinary-media");
const { logMediaDeletion } = require("../utils/mediaDeletionLog");
const stripe = require("../config/stripe");
const { createNotification } = require("../controllers/notifications.controller");
const { recalcTrustedParticipant } = require("../utils/trust");
const {
  collectComplianceIssues,
  syncHostComplianceSnapshot,
  isStripeAccountInaccessibleError,
  createHostComplianceAccessErrorSnapshot,
} = require("../utils/hostCompliance");
const { sendEmail } = require("../utils/mailer");
const { buildBookingCancelledEmail } = require("../utils/emailTemplates");
const {
  HOST_FEE_MODES,
  normalizeHostFeeMode,
  getGlobalHostPaysStripeConfig,
  buildStripeFeeConfig,
  calculateHostFeeBreakdown,
} = require("../utils/hostFeePolicy");
const { authenticate, requireAdminAllowlist, requireAdminCapability, requireOwnerAdmin } = require("../middleware/auth.middleware");
const {
  ADMIN_ROLES,
  ALL_USER_ROLES,
  ADMIN_CAPABILITIES,
  isAdminRole,
  hasAdminCapability,
  normalizeRole,
  getAdminCapabilities,
} = require("../utils/adminRoles");

const router = Router();
const cleanupActiveStatuses = ["PENDING", "PAID", "DEPOSIT_PAID", "CONFIRMED", "PENDING_ATTENDANCE", "DISPUTED"];
const adminBookingActiveStatuses = ["PENDING", "PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE", "DISPUTED"];
const adminParticipantStatuses = ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE", "COMPLETED", "AUTO_COMPLETED"];
const allowedUserRoles = ALL_USER_ROLES;
const adminBookingPaidStatuses = ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE", "DISPUTED"];
const adminBookingFinalStatuses = ["CANCELLED", "REFUNDED", "COMPLETED", "AUTO_COMPLETED", "NO_SHOW"];
const adminRateLimitState = new Map();
const ADMIN_RATE_LIMIT_WINDOW_MS = Number(process.env.ADMIN_RATE_LIMIT_WINDOW_MS || 60_000);
const ADMIN_RATE_LIMIT_MAX = Number(process.env.ADMIN_RATE_LIMIT_MAX || 240);
const hasOwnerWrite = (role) => hasAdminCapability(role, ADMIN_CAPABILITIES.OWNER_WRITE);
const HOST_FEE_POLICY_SAMPLE_AMOUNT_MINOR = 100 * 100;

const hasExperienceMedia = (exp) =>
  !!(
    (Array.isArray(exp?.mediaRefs) && exp.mediaRefs.length) ||
    (Array.isArray(exp?.images) && exp.images.length) ||
    (Array.isArray(exp?.videos) && exp.videos.length) ||
    exp?.mainImageUrl ||
    exp?.coverImageUrl
  );

const collectExperienceMediaUrls = (exp) =>
  [
    ...(exp?.images || []),
    ...(exp?.videos || []),
    exp?.mainImageUrl,
    exp?.coverImageUrl,
  ].filter(Boolean);

const buildExperienceMediaTargetsFromUrls = (urls) => {
  const refs = [];
  const seen = new Set();
  for (const url of urls || []) {
    const info = getCloudinaryInfo(url);
    if (!info) continue;
    const key = `${info.resourceType || "image"}:${info.publicId}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    refs.push({
      url,
      publicId: info.publicId,
      resourceType: info.resourceType,
    });
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
  return buildExperienceMediaTargetsFromUrls(collectExperienceMediaUrls(exp));
};

const adminDeleteExperienceRecord = async (exp, scope = "admin.experience.delete") => {
  const hasBookings = await Booking.findOne({ experience: exp._id }).select("_id");

  if (!hasBookings) {
    const mediaTargets = getExperienceMediaTargets(exp);
    await Experience.deleteOne({ _id: exp._id });
    let deletedMediaCount = 0;
    if (mediaTargets.length) {
      deletedMediaCount = await deleteCloudinaryUrls(mediaTargets, { scope });
      await logMediaDeletion({
        scope,
        requestedCount: mediaTargets.length,
        deletedCount: deletedMediaCount,
        entityType: "experience",
        entityId: exp._id,
        reason: "admin-delete-without-bookings",
      });
    }
    return {
      status: "deleted",
      experienceId: String(exp._id),
      groupId: exp.scheduleGroupId || null,
      hasBookings: false,
      deletedMediaCount,
    };
  }

  const before = {
    status: exp.status || "",
    isActive: exp.isActive !== false,
    soldOut: !!exp.soldOut,
    remainingSpots: Number(exp.remainingSpots ?? 0),
  };

  exp.status = "cancelled";
  exp.isActive = false;
  exp.soldOut = true;
  exp.remainingSpots = 0;
  await exp.save();

  return {
    status: "cancelled",
    experienceId: String(exp._id),
    groupId: exp.scheduleGroupId || null,
    hasBookings: true,
    before,
    after: {
      status: exp.status || "",
      isActive: exp.isActive !== false,
      soldOut: !!exp.soldOut,
      remainingSpots: Number(exp.remainingSpots ?? 0),
    },
  };
};

const adminDeleteExperienceSeries = async (groupId, scope = "admin.experience.series-delete") => {
  const experiences = await Experience.find({ scheduleGroupId: groupId });
  if (!experiences.length) return null;

  let deletedCount = 0;
  let skippedWithBookings = 0;
  let deletedMediaCount = 0;
  const deletedExperienceIds = [];
  const skippedExperienceIds = [];

  for (const exp of experiences) {
    const hasBookings = await Booking.findOne({ experience: exp._id }).select("_id");
    if (hasBookings) {
      skippedWithBookings += 1;
      skippedExperienceIds.push(String(exp._id));
      continue;
    }

    const mediaTargets = getExperienceMediaTargets(exp);
    await Experience.deleteOne({ _id: exp._id });
    deletedCount += 1;
    deletedExperienceIds.push(String(exp._id));

    if (mediaTargets.length) {
      const mediaDeletedForExp = await deleteCloudinaryUrls(mediaTargets, { scope });
      deletedMediaCount += mediaDeletedForExp;
      await logMediaDeletion({
        scope,
        requestedCount: mediaTargets.length,
        deletedCount: mediaDeletedForExp,
        entityType: "experience",
        entityId: exp._id,
        reason: "admin-group-delete-without-bookings",
      });
    }
  }

  return {
    groupId,
    total: experiences.length,
    deletedCount,
    skippedWithBookings,
    deletedMediaCount,
    deletedExperienceIds,
    skippedExperienceIds,
  };
};

const adminDisableExperienceSeries = async (groupId) => {
  const experiences = await Experience.find({ scheduleGroupId: groupId });
  if (!experiences.length) return null;

  let updatedCount = 0;
  const updatedExperienceIds = [];
  const alreadyDisabledIds = [];

  for (const exp of experiences) {
    const nextState = {
      isActive: false,
      status: "DISABLED",
      soldOut: true,
      remainingSpots: 0,
    };
    const unchanged =
      exp.isActive === nextState.isActive &&
      String(exp.status || "") === nextState.status &&
      !!exp.soldOut === nextState.soldOut &&
      Number(exp.remainingSpots ?? 0) === nextState.remainingSpots;

    if (unchanged) {
      alreadyDisabledIds.push(String(exp._id));
      continue;
    }

    exp.isActive = nextState.isActive;
    exp.status = nextState.status;
    exp.soldOut = nextState.soldOut;
    exp.remainingSpots = nextState.remainingSpots;
    await exp.save();
    updatedCount += 1;
    updatedExperienceIds.push(String(exp._id));
  }

  return {
    groupId,
    total: experiences.length,
    updatedCount,
    alreadyDisabledCount: alreadyDisabledIds.length,
    updatedExperienceIds,
    alreadyDisabledIds,
  };
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

const getCleanupEligibleAt = (exp) => {
  if (!exp) return null;
  if (String(exp.status || "").toUpperCase() === "NO_BOOKINGS") {
    return getExperienceEndDate(exp);
  }
  if (String(exp.status || "").toUpperCase() === "CANCELLED") {
    const updatedAt = exp.updatedAt ? new Date(exp.updatedAt) : null;
    if (updatedAt && !Number.isNaN(updatedAt.getTime())) return updatedAt;
  }
  return getExperienceEndDate(exp);
};

const verifyToken = (token) => {
  const secret = process.env.ADMIN_ACTION_SECRET || "admin-secret";
  return jwt.verify(token, secret);
};

const logAction = (action, bookingId) => {
  console.log(`[ADMIN_ACTION] ${new Date().toISOString()} action=${action} booking=${bookingId || "n/a"}`);
};

const getRequestIp = (req) => {
  const xfwd = req.headers["x-forwarded-for"];
  if (typeof xfwd === "string" && xfwd.trim()) {
    return xfwd.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "";
};

const adminRateLimit = (req, res, next) => {
  const now = Date.now();
  const key = `${req.user?.id || "anon"}:${getRequestIp(req)}`;
  const row = adminRateLimitState.get(key);

  if (!row || now - row.windowStart > ADMIN_RATE_LIMIT_WINDOW_MS) {
    adminRateLimitState.set(key, { windowStart: now, count: 1 });
    return next();
  }

  row.count += 1;
  adminRateLimitState.set(key, row);

  if (row.count > ADMIN_RATE_LIMIT_MAX) {
    return res.status(429).json({ message: "Too many admin requests" });
  }
  return next();
};

const legacyAdminSessionGuards = [
  authenticate,
  requireAdminAllowlist,
  adminRateLimit,
  requireAdminCapability(ADMIN_CAPABILITIES.REPORTS_WRITE),
];

const requireReason = (req, res, next) => {
  const method = String(req.method || "").toUpperCase();
  if (!["PATCH", "POST", "PUT", "DELETE"].includes(method)) return next();
  const reason = String(req.body?.reason || "").trim();
  req.adminReason = reason;
  return next();
};

const parseBoolFilter = (value) => {
  if (value === undefined || value === null || value === "" || value === "all") return undefined;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
};

const clampLimit = (value, fallback = 20, max = 100) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
};

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const writeAdminAuditLog = async (req, payload = {}) => {
  try {
    if (!req.user?.id || !req.user?.email) return;
    await AdminAuditLog.create({
      actorId: req.user.id,
      actorEmail: req.user.email,
      ip: getRequestIp(req),
      userAgent: String(req.headers["user-agent"] || ""),
      ...payload,
    });
  } catch (err) {
    console.error("Admin audit log write error", err);
  }
};

const splitName = (value = "") => {
  const cleaned = String(value || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return { firstName: "", lastName: "" };
  const parts = cleaned.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
};

const serializeAdminUser = (user) => ({
  ...splitName(user.displayName || user.display_name || user.name || ""),
  id: String(user._id),
  name: user.name || "",
  fullName: user.displayName || user.display_name || user.name || "",
  displayName: user.displayName || user.display_name || user.name || "",
  email: user.email || "",
  role: user.role,
  isBlocked: !!user.isBlocked,
  isBanned: !!user.isBanned,
  emailVerified: !!user.emailVerified,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  city: user.city || "",
  country: user.country || "",
  stripeAccountId: user.stripeAccountId || "",
  isStripeChargesEnabled: !!user.isStripeChargesEnabled,
  isStripePayoutsEnabled: !!user.isStripePayoutsEnabled,
  stripeConnected: !!user.stripeAccountId,
});

const serializeAdminExperience = (exp, participantsByExperience = new Map()) => ({
  id: String(exp._id),
  title: exp.title || "",
  status: exp.status || "",
  isActive: exp.isActive !== false,
  scheduleGroupId: exp.scheduleGroupId || null,
  isSeries: !!exp.scheduleGroupId,
  seriesId: exp.scheduleGroupId || null,
  price: typeof exp.price === "number" ? exp.price : 0,
  environment: exp.environment || null,
  city: exp.city || exp.location?.city || "",
  country: exp.country || exp.location?.country || "",
  startsAt: exp.startsAt || exp.startDate || null,
  endsAt: exp.endsAt || exp.endDate || null,
  maxParticipants: exp.maxParticipants ?? 0,
  remainingSpots: exp.remainingSpots ?? 0,
  soldOut: !!exp.soldOut,
  createdAt: exp.createdAt,
  updatedAt: exp.updatedAt,
  host: exp.host
    ? {
        id: String(exp.host._id || exp.host),
        name: exp.host.displayName || exp.host.display_name || exp.host.name || "",
        email: exp.host.email || "",
      }
    : null,
  participantsBooked: participantsByExperience.get(String(exp._id)) || 0,
});

const isObjectIdLike = (value) => /^[a-f\d]{24}$/i.test(String(value || ""));

const serializeAdminBooking = (booking, extras = {}) => ({
  id: String(booking._id),
  status: booking.status || "",
  attendanceStatus: booking.attendanceStatus || "",
  quantity: Number(booking.quantity || 1),
  amount: Number(booking.amount || 0),
  currency: booking.currency || "ron",
  payoutEligibleAt: booking.payoutEligibleAt || null,
  createdAt: booking.createdAt,
  updatedAt: booking.updatedAt,
  cancelledAt: booking.cancelledAt || null,
  refundedAt: booking.refundedAt || null,
  disputeReason: booking.disputeReason || null,
  date: booking.date || null,
  host: booking.host
    ? {
        id: String(booking.host._id || booking.host),
        name: booking.host.displayName || booking.host.display_name || booking.host.name || "",
        email: booking.host.email || "",
      }
    : null,
  explorer: booking.explorer
    ? {
        id: String(booking.explorer._id || booking.explorer),
        name: booking.explorer.displayName || booking.explorer.display_name || booking.explorer.name || "",
        email: booking.explorer.email || "",
      }
    : null,
  experience: booking.experience
    ? {
        id: String(booking.experience._id || booking.experience),
        title: booking.experience.title || "",
        startsAt: booking.experience.startsAt || booking.experience.startDate || null,
        endsAt: booking.experience.endsAt || booking.experience.endDate || null,
        city: booking.experience.city || "",
        country: booking.experience.country || "",
        price: typeof booking.experience.price === "number" ? booking.experience.price : 0,
        isActive: booking.experience.isActive !== false,
        status: booking.experience.status || "",
      }
    : null,
  payment: extras.payment || null,
  reportsCount: Number(extras.reportsCount || 0),
  messagesCount: Number(extras.messagesCount || 0),
});

const serializeAdminReport = (report, extras = {}) => {
  const createdAt = report.createdAt ? new Date(report.createdAt) : null;
  const deadlineAt = report.deadlineAt ? new Date(report.deadlineAt) : null;
  const now = extras.now instanceof Date ? extras.now : new Date();
  const ageHours = createdAt ? Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / (60 * 60 * 1000))) : 0;
  const overdue = !!deadlineAt && deadlineAt.getTime() < now.getTime() && ["OPEN", "INVESTIGATING"].includes(String(report.status || ""));
  const booking = report.booking && typeof report.booking === "object" ? report.booking : null;
  const experience = report.experience && typeof report.experience === "object" ? report.experience : null;
  return {
    id: String(report._id),
    type: report.type || "",
    status: report.status || "",
    reason: report.reason || "",
    comment: report.comment || "",
    affectsPayout: !!report.affectsPayout,
    actionTaken: report.actionTaken || "",
    createdAt: report.createdAt || null,
    deadlineAt: report.deadlineAt || null,
    handledAt: report.handledAt || null,
    handledBy: report.handledBy || "",
    assignedTo: report.assignedTo || "",
    assignedAt: report.assignedAt || null,
    ageHours,
    overdue,
    targetType: report.targetType || null,
    reporter: report.reporter
      ? {
          id: String(report.reporter._id || report.reporter),
          name: report.reporter.displayName || report.reporter.display_name || report.reporter.name || "",
          email: report.reporter.email || "",
        }
      : null,
    host: report.host
      ? {
          id: String(report.host._id || report.host),
          name: report.host.displayName || report.host.display_name || report.host.name || "",
          email: report.host.email || "",
        }
      : null,
    targetUser: report.targetUserId
      ? {
          id: String(report.targetUserId._id || report.targetUserId),
          name: report.targetUserId.displayName || report.targetUserId.display_name || report.targetUserId.name || "",
          email: report.targetUserId.email || "",
          isBlocked: !!report.targetUserId.isBlocked,
          isBanned: !!report.targetUserId.isBanned,
        }
      : null,
    experience: experience
      ? {
          id: String(experience._id || experience),
          title: experience.title || "",
          status: experience.status || "",
          isActive: experience.isActive !== false,
          city: experience.city || "",
          country: experience.country || "",
        }
      : null,
    booking: booking
      ? {
          id: String(booking._id || booking),
          status: booking.status || "",
          quantity: Number(booking.quantity || 1),
        }
      : null,
    messagesCount: Number(extras.messagesCount || 0),
  };
};

const serializeAdminMessage = (message) => ({
  id: String(message._id),
  bookingId: message.booking ? String(message.booking._id || message.booking) : "",
  sender: message.sender
    ? {
        id: String(message.sender._id || message.sender),
        name: message.sender.displayName || message.sender.display_name || message.sender.name || "",
        email: message.sender.email || "",
      }
    : null,
  senderProfile: message.senderProfile || null,
  message: message.message || "",
  createdAt: message.createdAt || null,
  updatedAt: message.updatedAt || null,
});

const serializeAdminPaymentsHost = (user) => ({
  id: String(user._id),
  name: user.displayName || user.display_name || user.name || "",
  email: user.email || "",
  role: user.role || "",
  isBlocked: !!user.isBlocked,
  isBanned: !!user.isBanned,
  stripeAccountId: user.stripeAccountId || null,
  isStripeChargesEnabled: !!user.isStripeChargesEnabled,
  isStripePayoutsEnabled: !!user.isStripePayoutsEnabled,
  isStripeDetailsSubmitted: !!user.isStripeDetailsSubmitted,
  hostFeeMode: normalizeHostFeeMode(user.hostFeeMode),
  hostStripeFeePercentBps: Number(user.hostStripeFeePercentBps || 0),
  hostStripeFeeFixedMinor: Number(user.hostStripeFeeFixedMinor || 0),
  totalEvents: Number(user.total_events || 0),
  totalParticipants: Number(user.total_participants || 0),
  createdAt: user.createdAt || null,
});

const buildAdminHostFeePolicy = (user) => {
  const globalStripeFeeConfig = getGlobalHostPaysStripeConfig();
  const currentMode = normalizeHostFeeMode(user?.hostFeeMode);
  const savedStripeFeeConfig = buildStripeFeeConfig({
    percentBps: user?.hostStripeFeePercentBps,
    fixedMinor: user?.hostStripeFeeFixedMinor,
  });
  const previewAmountMinor = HOST_FEE_POLICY_SAMPLE_AMOUNT_MINOR;

  return {
    currentMode,
    sampleAmountMinor: previewAmountMinor,
    canEdit: true,
    globalStripeFeeConfig,
    savedStripeFeeConfig,
    preview: {
      standard: calculateHostFeeBreakdown({
        amountMinor: previewAmountMinor,
        feeMode: HOST_FEE_MODES.STANDARD,
      }),
      hostPaysStripe: calculateHostFeeBreakdown({
        amountMinor: previewAmountMinor,
        feeMode: HOST_FEE_MODES.HOST_PAYS_STRIPE,
        stripeFeeConfig: currentMode === HOST_FEE_MODES.HOST_PAYS_STRIPE && savedStripeFeeConfig.configured ? savedStripeFeeConfig : globalStripeFeeConfig,
      }),
      availableModes: [
        {
          value: HOST_FEE_MODES.STANDARD,
          label: "Standard",
        },
        {
          value: HOST_FEE_MODES.HOST_PAYS_STRIPE,
          label: "0% LIVADAI + host pays Stripe",
        },
      ],
    },
  };
};

const serializeAdminComplianceHost = (user, snapshot = null) => {
  const base = serializeAdminPaymentsHost(user);
  const issues = collectComplianceIssues(snapshot);
  const bankLast4 = String(snapshot?.bankLast4 || "");
  const bankName = String(snapshot?.bankName || "");
  const bankReference = bankLast4 ? `${bankName || "Bank"} • ****${bankLast4}` : "";
  return {
    ...base,
    livadaiName: base.name || "",
    stripeLegalName: String(snapshot?.stripeLegalName || ""),
    stripeDisplayName: String(snapshot?.stripeDisplayName || ""),
    stripeNameSource: String(snapshot?.stripeNameSource || ""),
    stripeBusinessType: String(snapshot?.stripeBusinessType || ""),
    nameMatchState: snapshot?.nameMatchState || "NO_SNAPSHOT",
    bankName,
    bankLast4,
    bankCountry: String(snapshot?.bankCountry || ""),
    bankCurrency: String(snapshot?.bankCurrency || ""),
    bankReferenceSource: String(snapshot?.bankReferenceSource || ""),
    bankReference,
    requirementsDisabledReason: String(snapshot?.requirementsDisabledReason || ""),
    requirementsCurrentlyDueCount: Number(snapshot?.requirementsCurrentlyDue?.length || 0),
    snapshotAt: snapshot?.createdAt || null,
    issues,
    feePolicy: buildAdminHostFeePolicy(user),
  };
};

const serializeAdminPaymentIssueBooking = (booking, extras = {}) => ({
  id: String(booking._id),
  status: booking.status || "",
  quantity: Number(booking.quantity || 1),
  amount: Number(booking.amount || 0),
  currency: booking.currency || "ron",
  payoutEligibleAt: booking.payoutEligibleAt || null,
  refundedAt: booking.refundedAt || null,
  cancelledAt: booking.cancelledAt || null,
  refundAttempts: Number(booking.refundAttempts || 0),
  lastRefundAttemptAt: booking.lastRefundAttemptAt || null,
  createdAt: booking.createdAt || null,
  host: booking.host
    ? {
        id: String(booking.host._id || booking.host),
        name: booking.host.displayName || booking.host.display_name || booking.host.name || "",
        email: booking.host.email || "",
        stripeAccountId: booking.host.stripeAccountId || null,
        isStripeChargesEnabled: !!booking.host.isStripeChargesEnabled,
        isStripePayoutsEnabled: !!booking.host.isStripePayoutsEnabled,
        isStripeDetailsSubmitted: !!booking.host.isStripeDetailsSubmitted,
      }
    : null,
  explorer: booking.explorer
    ? {
        id: String(booking.explorer._id || booking.explorer),
        name: booking.explorer.displayName || booking.explorer.display_name || booking.explorer.name || "",
        email: booking.explorer.email || "",
      }
    : null,
  experience: booking.experience
    ? {
        id: String(booking.experience._id || booking.experience),
        title: booking.experience.title || "",
        city: booking.experience.city || "",
        country: booking.experience.country || "",
        startsAt: booking.experience.startsAt || booking.experience.startDate || null,
        status: booking.experience.status || "",
        isActive: booking.experience.isActive !== false,
      }
    : null,
  payment: extras.payment || null,
  issueReason: extras.issueReason || "",
});

const getLatestHostComplianceMap = async (userIds = []) => {
  if (!Array.isArray(userIds) || !userIds.length) return new Map();
  const objectIds = userIds
    .map((id) => {
      try {
        return new mongoose.Types.ObjectId(id);
      } catch (_err) {
        return null;
      }
    })
    .filter(Boolean);
  if (!objectIds.length) return new Map();

  const rows = await HostComplianceSnapshot.aggregate([
    { $match: { user: { $in: objectIds } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$user", latest: { $first: "$$ROOT" } } },
    { $replaceRoot: { newRoot: "$latest" } },
  ]);
  return new Map(rows.map((row) => [String(row.user), row]));
};

const syncHostComplianceSnapshotSafe = async (userId, triggerEventType = "") => {
  if (!userId) return { snapshot: null, error: "Missing user id" };
  try {
    const snapshot = await syncHostComplianceSnapshot({
      userId,
      triggerType: "admin",
      triggerEventType: triggerEventType || "admin.hosts.view",
      metadata: { source: "admin.routes" },
    });
    return {
      snapshot: snapshot ? (typeof snapshot.toObject === "function" ? snapshot.toObject() : snapshot) : null,
      error: "",
    };
  } catch (err) {
    if (isStripeAccountInaccessibleError(err)) {
      const snapshot = await createHostComplianceAccessErrorSnapshot({
        userId,
        triggerType: "admin",
        triggerEventType: triggerEventType || "admin.hosts.view",
        metadata: { source: "admin.routes", recovery: "stripe-account-inaccessible" },
        error: err,
      });
      console.warn("Admin compliance sync marked Stripe account inaccessible", {
        userId: String(userId),
        triggerEventType: triggerEventType || "admin.hosts.view",
        stripeCode: String(err?.code || ""),
      });
      return {
        snapshot: snapshot ? (typeof snapshot.toObject === "function" ? snapshot.toObject() : snapshot) : null,
        error: "",
      };
    }
    const message = err?.message || String(err);
    console.error("Admin compliance sync error", {
      userId: String(userId),
      triggerEventType: triggerEventType || "admin.hosts.view",
      message,
    });
    return { snapshot: null, error: String(message) };
  }
};

const ensureComplianceMapHasStripeData = async (rows = [], complianceMap = new Map(), triggerEventType = "") => {
  const map = complianceMap instanceof Map ? complianceMap : new Map();
  if (!Array.isArray(rows) || !rows.length) return map;

  for (const row of rows) {
    const id = String(row?._id || "");
    if (!id || !row?.stripeAccountId) continue;
    const existingSnapshot = map.get(id);
    const hasStripeName = String(existingSnapshot?.stripeLegalName || existingSnapshot?.stripeDisplayName || "").trim();
    const hasBankRef = String(existingSnapshot?.bankLast4 || "").trim();
    const stripeAccessStatus = String(existingSnapshot?.metadata?.stripeAccessStatus || "").trim().toUpperCase();
    const snapshotStripeAccountId = String(existingSnapshot?.stripeAccountId || "").trim();
    const currentStripeAccountId = String(row?.stripeAccountId || "").trim();
    if (
      existingSnapshot &&
      stripeAccessStatus === "INACCESSIBLE" &&
      snapshotStripeAccountId &&
      snapshotStripeAccountId === currentStripeAccountId
    ) {
      continue;
    }
    if (existingSnapshot && hasStripeName && hasBankRef) continue;

    const synced = await syncHostComplianceSnapshotSafe(row._id, triggerEventType || "admin.hosts.list");
    if (synced?.snapshot) map.set(id, synced.snapshot);
  }

  return map;
};

const restoreExperienceSpotsForCancelledBooking = async (booking, expDoc) => {
  if (!expDoc) return;
  const qty = Number(booking.quantity || 1);
  const total = Number(expDoc.maxParticipants || qty);
  const currentRemaining = Number.isFinite(expDoc.remainingSpots) ? Number(expDoc.remainingSpots) : Math.max(0, total - qty);
  expDoc.remainingSpots = Math.min(total, currentRemaining + qty);
  if (expDoc.remainingSpots > 0) expDoc.soldOut = false;
  await expDoc.save();
};

const refundBooking = async (booking, reason = "Admin action") => {
  try {
    const payment = await Payment.findOne({ booking: booking._id, status: { $in: ["CONFIRMED", "INITIATED"] } });
    if (payment?.stripePaymentIntentId) {
      await stripe.refunds.create({ payment_intent: payment.stripePaymentIntentId });
      payment.status = "REFUNDED";
      await payment.save();
    }
    booking.status = "REFUNDED";
    booking.refundedAt = new Date();
    booking.payoutEligibleAt = null;
    await booking.save();
    try {
      await createNotification({
        user: booking.explorer,
        type: "BOOKING_CANCELLED",
        title: "Booking refunded",
        message: `Booking was refunded: ${reason}.`,
        data: { bookingId: booking._id, activityId: booking.experience },
        push: true,
      });
    } catch (err) {
      console.error("notify refund error", err);
    }
  } catch (err) {
    console.error("Refund booking error", err);
  }
};

const applyResolve = async (bookingId) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) return "Booking not found";
  booking.status = "COMPLETED";
  booking.disputedAt = null;
  booking.disputeReason = null;
  booking.disputeComment = null;
  if (!booking.disputeResolvedAt) {
    booking.disputeResolvedAt = new Date();
  }
  const base = booking.completedAt || new Date();
  booking.completedAt = base;
  booking.payoutEligibleAt = new Date(base.getTime() + 72 * 60 * 60 * 1000);
  await booking.save();
  return "Booking marked resolved";
};

const applyIgnore = async (bookingId) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) return "Booking not found";
  booking.disputedAt = null;
  booking.disputeReason = null;
  booking.disputeComment = null;
  if (!booking.disputeResolvedAt) {
    booking.disputeResolvedAt = new Date();
  }
  if (booking.status === "DISPUTED") booking.status = "COMPLETED";
  if (booking.completedAt) {
    booking.payoutEligibleAt = new Date(booking.completedAt.getTime() + 72 * 60 * 60 * 1000);
  }
  await booking.save();
  return "Booking dispute ignored";
};

const applyRefundExplorer = async (bookingId) => {
  const booking = await Booking.findById(bookingId);
  if (!booking) return "Booking not found";
  booking.status = "CANCELLED";
  booking.cancelledAt = new Date();
  booking.payoutEligibleAt = null;
  if (!booking.disputeResolvedAt) {
    booking.disputeResolvedAt = new Date();
  }
  await booking.save();
  return "Booking marked for refund/cancelled";
};

const applyBanExplorer = async (explorerId) => {
  const user = await User.findById(explorerId);
  if (!user) return "Explorer not found";
  user.isBlocked = true;
  user.isBanned = true;
  await user.save();
  return "Explorer banned";
};

const applyDisableExperience = async (experienceId) => {
  const exp = await Experience.findById(experienceId);
  if (!exp) return "Experience not found";
  exp.isActive = false;
  exp.status = "DISABLED";
  exp.soldOut = true;
  exp.remainingSpots = 0;
  await exp.save();
  const bookings = await Booking.find({
    experience: experienceId,
    status: { $in: ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE"] },
  }).populate("explorer", "email name displayName");
  const hostUser = await User.findById(exp.host).select("email name displayName");
  const appUrl = process.env.FRONTEND_URL || "https://app.livadai.com";
  const exploreUrl = `${appUrl.replace(/\/$/, "")}/experiences`;
  for (const b of bookings) {
    await refundBooking(b, "Experience disabled by admin");
    try {
      if (b.explorer?.email) {
        const html = buildBookingCancelledEmail({
          experience: exp,
          bookingId: b._id,
          ctaUrl: exploreUrl,
          role: "explorer",
        });
        await sendEmail({
          to: b.explorer.email,
          subject: `Experiență anulată: ${exp?.title || "LIVADAI"} (#${b._id})`,
          html,
          type: "booking_cancelled",
          userId: b.explorer._id,
        });
      }
    } catch (err) {
      console.error("Disable experience email error", err);
    }
  }
  try {
    if (hostUser?.email) {
      const html = buildBookingCancelledEmail({
        experience: exp,
        ctaUrl: exploreUrl,
        role: "host",
      });
      await sendEmail({
        to: hostUser.email,
        subject: `Experiență anulată: ${exp?.title || "LIVADAI"} (host)`,
        html,
        type: "booking_cancelled",
        userId: hostUser._id,
      });
    }
  } catch (err) {
    console.error("Disable experience host email error", err);
  }
  await Booking.updateMany(
    { experience: experienceId, status: { $in: ["PENDING", "CANCELLED", "REFUNDED"] } },
    { payoutEligibleAt: null }
  );
  return "Experience disabled; bookings refunded/cancelled";
};

const applyBanHost = async (hostId) => {
  const host = await User.findById(hostId);
  if (!host) return "Host not found";
  host.isBlocked = true;
  host.isBanned = true;
  await host.save();
  await Experience.updateMany({ host: hostId }, { isActive: false, status: "DISABLED", soldOut: true, remainingSpots: 0 });
  const bookings = await Booking.find({
    host: hostId,
    status: { $in: ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE"] },
  });
  for (const b of bookings) {
    await refundBooking(b, "Host banned by admin");
  }
  await Booking.updateMany(
    { host: hostId, status: { $nin: ["REFUNDED", "CANCELLED"] } },
    { payoutEligibleAt: null }
  );
  return "Host blocked, experiences disabled, bookings refunded";
};

const handleAction = async (req, res) => {
  try {
    const { action, bookingId, hostId, experienceId, explorerId, reportId, token, confirm, confirmText } = {
      ...req.query,
      ...req.body,
    };
    const actorHasOwnerWrite = hasOwnerWrite(req.user?.role);
    if (!token) return res.status(401).send("Missing token");
    let payload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      return res.status(401).send("Invalid or expired token");
    }
    // optional: validate reportId matches token payload if present
    if (payload?.reportId && reportId && payload.reportId !== reportId) {
      return res.status(401).send("Token/report mismatch");
    }

    if (
      ![
        "BAN_HOST",
        "DISABLE_EXPERIENCE",
        "RESOLVE",
        "IGNORE",
        "REFUND_EXPLORER",
        "BAN_EXPLORER",
        "RESOLVE_PAYOUT",
        "IGNORE_REPORT",
      ].includes(action)
    ) {
      return res.status(400).send("Invalid action");
    }

    const criticalActions = ["BAN_HOST", "BAN_EXPLORER", "DISABLE_EXPERIENCE"];
    const needsText = criticalActions.includes(action);
    const requiredWord = action === "DISABLE_EXPERIENCE" ? "DISABLE" : "BAN";
    if (!confirm) {
      return res.status(400).send("Confirmation checkbox required");
    }
    if (needsText && (!confirmText || confirmText.trim().toUpperCase() !== requiredWord)) {
      return res.status(400).send(`Type ${requiredWord} to confirm this action`);
    }

    if (action === "BAN_HOST" && hostId) {
      const targetHost = await User.findById(hostId).select("role");
      if (targetHost && isAdminRole(targetHost.role) && !actorHasOwnerWrite) {
        return res.status(403).send("Only owner admin can ban another admin");
      }
    }
    if (action === "BAN_EXPLORER" && explorerId) {
      const targetExplorer = await User.findById(explorerId).select("role");
      if (targetExplorer && isAdminRole(targetExplorer.role) && !actorHasOwnerWrite) {
        return res.status(403).send("Only owner admin can ban another admin");
      }
    }

    let message = "OK";
    if (action === "BAN_HOST") message = await applyBanHost(hostId);
    if (action === "DISABLE_EXPERIENCE") message = await applyDisableExperience(experienceId);
    if (action === "RESOLVE" || action === "RESOLVE_PAYOUT") message = await applyResolve(bookingId);
    if (action === "IGNORE" || action === "IGNORE_REPORT") message = await applyIgnore(bookingId);
    if (action === "REFUND_EXPLORER") message = await applyRefundExplorer(bookingId);
    if (action === "BAN_EXPLORER") message = await applyBanExplorer(explorerId);

    if (reportId) {
      const report = await Report.findByIdAndUpdate(
        reportId,
        {
          status: action === "IGNORE" || action === "IGNORE_REPORT" ? "IGNORED" : "HANDLED",
          handledAt: new Date(),
          handledBy: "admin-email-action",
          actionTaken: action,
        },
        { new: true }
      );
      if (report?.targetUserId) {
        try {
          await recalcTrustedParticipant(report.targetUserId);
        } catch (err) {
          console.error("recalcTrustedParticipant (admin) error", err);
        }
      }
    }

    logAction(action, bookingId);
    return res.send(message);
  } catch (err) {
    console.error("Admin action error", err);
    return res.status(500).send("Server error");
  }
};

// confirmation + execution split: GET renders confirm page, POST executes
router.get("/report-action", ...legacyAdminSessionGuards, async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(401).send("Missing token");
    let payload;
    try {
      payload = verifyToken(token);
    } catch (err) {
      return res.status(401).send("Invalid or expired token");
    }
    const { action, bookingId, hostId, explorerId, experienceId, reportId } = { ...payload, ...req.query };
    const needsText = ["BAN_HOST", "BAN_EXPLORER", "DISABLE_EXPERIENCE"].includes(action);
    const requiredWord = action === "DISABLE_EXPERIENCE" ? "DISABLE" : "BAN";
    const confirmLabel =
      action === "DISABLE_EXPERIENCE"
        ? "You are about to DISABLE this experience. This action is irreversible."
        : action === "BAN_HOST"
          ? "You are about to BAN this host. All their experiences will be disabled."
          : action === "BAN_EXPLORER"
            ? "You are about to BAN this explorer. They will no longer be able to book."
            : "This action will update the report.";
    const title =
      action === "DISABLE_EXPERIENCE"
        ? "Disable Experience"
        : action === "BAN_HOST"
          ? "Ban Host"
          : action === "BAN_EXPLORER"
            ? "Ban Explorer"
            : action === "IGNORE" || action === "IGNORE_REPORT"
              ? "Ignore Report"
              : "Admin action";
    const warning =
      action === "IGNORE" || action === "IGNORE_REPORT"
        ? "This will mark the report as ignored."
        : "This action is irreversible and affects real users/bookings.";

    const html = `
      <h2>${title}</h2>
      <p>${warning}</p>
      <form method="POST" action="/admin/report-action">
        <input type="hidden" name="token" value="${token}" />
        <input type="hidden" name="action" value="${action}" />
        ${bookingId ? `<input type="hidden" name="bookingId" value="${bookingId}" />` : ""}
        ${hostId ? `<input type="hidden" name="hostId" value="${hostId}" />` : ""}
        ${explorerId ? `<input type="hidden" name="explorerId" value="${explorerId}" />` : ""}
        ${experienceId ? `<input type="hidden" name="experienceId" value="${experienceId}" />` : ""}
        ${reportId ? `<input type="hidden" name="reportId" value="${reportId}" />` : ""}
        <p>${confirmLabel}</p>
        <p><label><input type="checkbox" name="confirm" /> I understand this action is irreversible and affects real users.</label></p>
        ${
          needsText
            ? `<p>Type <strong>${requiredWord}</strong> to confirm: <input name="confirmText" /></p>`
            : ""
        }
        <button type="submit">Confirm</button>
      </form>
    `;
    return res.send(html);
  } catch (err) {
    console.error("Admin GET action error", err);
    return res.status(500).send("Server error");
  }
});

router.post("/report-action", ...legacyAdminSessionGuards, handleAction);

// All session-based admin routes below require admin auth + founder allowlist + base panel read access.
router.use(
  authenticate,
  requireAdminAllowlist,
  adminRateLimit,
  requireAdminCapability(ADMIN_CAPABILITIES.PANEL_READ),
  requireReason
);

router.get("/me/permissions", (req, res) => {
  const role = normalizeRole(req.user?.role);
  const capabilities = getAdminCapabilities(role);
  return res.json({
    role,
    capabilities,
    can: {
      panelRead: capabilities.includes(ADMIN_CAPABILITIES.PANEL_READ),
      usersWrite: capabilities.includes(ADMIN_CAPABILITIES.USERS_WRITE),
      experiencesWrite: capabilities.includes(ADMIN_CAPABILITIES.EXPERIENCES_WRITE),
      bookingsWrite: capabilities.includes(ADMIN_CAPABILITIES.BOOKINGS_WRITE),
      reportsWrite: capabilities.includes(ADMIN_CAPABILITIES.REPORTS_WRITE),
      ownerWrite: capabilities.includes(ADMIN_CAPABILITIES.OWNER_WRITE),
    },
  });
});

router.get("/dashboard", async (_req, res) => {
  try {
    const now = new Date();

    const [
      usersTotal,
      explorersOnly,
      hostsOnly,
      bothRole,
      admins,
      blockedUsers,
      bannedUsers,
      experiencesTotal,
      experiencesActive,
      experiencesInactive,
      experiencesUpcomingPublic,
      bookingsTotal,
      bookingsActive,
      bookingsRefundFailed,
      reportsOpen,
      reportsPending,
      recentUsers,
      recentExperiences,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: "EXPLORER" }),
      User.countDocuments({ role: "HOST" }),
      User.countDocuments({ role: "BOTH" }),
      User.countDocuments({ role: { $in: ADMIN_ROLES } }),
      User.countDocuments({ isBlocked: true }),
      User.countDocuments({ isBanned: true }),
      Experience.countDocuments({}),
      Experience.countDocuments({ isActive: true }),
      Experience.countDocuments({ isActive: false }),
      Experience.countDocuments({ isActive: true, startsAt: { $gt: now } }),
      Booking.countDocuments({}),
      Booking.countDocuments({ status: { $in: adminBookingActiveStatuses } }),
      Booking.countDocuments({ status: "REFUND_FAILED" }),
      Report.countDocuments({ status: "OPEN" }),
      Report.countDocuments({ status: { $in: ["OPEN", "INVESTIGATING", "HANDLED"] } }),
      User.countDocuments({ createdAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } }),
      Experience.countDocuments({ createdAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } }),
    ]);

    return res.json({
      generatedAt: now.toISOString(),
      users: {
        total: usersTotal,
        explorersOnly,
        hostsOnly,
        bothRole,
        admins,
        hostCapable: hostsOnly + bothRole,
        explorerCapable: explorersOnly + bothRole,
        blocked: blockedUsers,
        banned: bannedUsers,
        newLast7d: recentUsers,
      },
      experiences: {
        total: experiencesTotal,
        active: experiencesActive,
        inactive: experiencesInactive,
        upcomingPublic: experiencesUpcomingPublic,
        newLast7d: recentExperiences,
      },
      bookings: {
        total: bookingsTotal,
        active: bookingsActive,
        refundFailed: bookingsRefundFailed,
      },
      reports: {
        open: reportsOpen,
        openOrHandled: reportsPending,
      },
    });
  } catch (err) {
    console.error("Admin dashboard error", err);
    return res.status(500).json({ message: "Failed to load admin dashboard" });
  }
});

router.get("/audit-logs/recent", async (req, res) => {
  try {
    const limit = clampLimit(req.query.limit, 10, 50);
    const rows = await AdminAuditLog.find({})
      .select("actorEmail actionType targetType targetId reason createdAt")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      items: rows.map((row) => ({
        id: String(row._id),
        actorEmail: row.actorEmail || "",
        actionType: row.actionType || "",
        targetType: row.targetType || "",
        targetId: row.targetId || "",
        reason: row.reason || "",
        createdAt: row.createdAt,
      })),
    });
  } catch (err) {
    console.error("Admin audit recent error", err);
    return res.status(500).json({ message: "Failed to load recent admin actions" });
  }
});

router.get("/audit-logs", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const actionType = String(req.query.actionType || "").trim().toUpperCase();
    const targetType = String(req.query.targetType || "").trim().toLowerCase();
    const actorEmail = String(req.query.actorEmail || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const limit = clampLimit(req.query.limit, 20, 100);
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const skip = (page - 1) * limit;

    const filter = {};

    if (actionType && actionType !== "ALL") {
      filter.actionType = actionType;
    }
    if (targetType && targetType !== "all") {
      filter.targetType = targetType;
    }
    if (actorEmail) {
      filter.actorEmail = { $regex: escapeRegex(actorEmail), $options: "i" };
    }

    const createdAt = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) createdAt.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) createdAt.$lte = new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
    if (Object.keys(createdAt).length) {
      filter.createdAt = createdAt;
    }

    if (q) {
      const safe = escapeRegex(q);
      const or = [
        { actorEmail: { $regex: safe, $options: "i" } },
        { actionType: { $regex: safe, $options: "i" } },
        { targetType: { $regex: safe, $options: "i" } },
        { targetId: { $regex: safe, $options: "i" } },
        { reason: { $regex: safe, $options: "i" } },
      ];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: or }];
        delete filter.$or;
      } else {
        filter.$or = or;
      }
    }

    const [total, rows] = await Promise.all([
      AdminAuditLog.countDocuments(filter),
      AdminAuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    return res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      items: rows.map((row) => ({
        id: String(row._id),
        actorId: row.actorId ? String(row.actorId) : "",
        actorEmail: row.actorEmail || "",
        actionType: row.actionType || "",
        targetType: row.targetType || "",
        targetId: row.targetId || "",
        reason: row.reason || "",
        diff: row.diff || null,
        meta: row.meta || null,
        ip: row.ip || "",
        userAgent: row.userAgent || "",
        createdAt: row.createdAt || null,
      })),
    });
  } catch (err) {
    console.error("Admin audit logs list error", err);
    return res.status(500).json({ message: "Failed to load audit logs" });
  }
});

router.get("/users", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const role = String(req.query.role || "").trim().toUpperCase();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const limit = clampLimit(req.query.limit, 20, 20);
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const skip = (page - 1) * limit;

    const filter = {};

    if (q) {
      const safe = escapeRegex(q);
      filter.email = { $regex: safe, $options: "i" };
    }

    if (allowedUserRoles.includes(role)) {
      filter.role = role;
    }

    if (status === "blocked") filter.isBlocked = true;
    if (status === "banned") filter.isBanned = true;
    if (status === "active") {
      filter.isBlocked = { $ne: true };
      filter.isBanned = { $ne: true };
    }

    const [total, rows, totalUsers, totalHosts, totalExplorers, hostsStripeIncomplete] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select(
          [
            "name",
            "displayName",
            "display_name",
            "email",
            "role",
            "isBlocked",
            "isBanned",
            "emailVerified",
            "city",
            "country",
            "stripeAccountId",
            "isStripeChargesEnabled",
            "isStripePayoutsEnabled",
            "tokenVersion",
            "createdAt",
            "updatedAt",
          ].join(" ")
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments({}),
      User.countDocuments({ role: { $in: ["HOST", "BOTH"] } }),
      User.countDocuments({ role: { $in: ["EXPLORER", "BOTH"] } }),
      User.countDocuments({
        role: { $in: ["HOST", "BOTH"] },
        $or: [
          { stripeAccountId: { $exists: false } },
          { stripeAccountId: "" },
          { isStripeChargesEnabled: { $ne: true } },
          { isStripePayoutsEnabled: { $ne: true } },
        ],
      }),
    ]);

    return res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      summary: {
        totalUsers,
        totalHosts,
        totalExplorers,
        hostsStripeIncomplete,
      },
      items: rows.map(serializeAdminUser),
    });
  } catch (err) {
    console.error("Admin users list error", err);
    return res.status(500).json({ message: "Failed to load users" });
  }
});

router.get("/hosts", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const limit = clampLimit(req.query.limit, 20, 50);
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const skip = (page - 1) * limit;
    const now = new Date();

    const filter = {
      role: { $in: ["HOST", "BOTH"] },
    };

    if (q) {
      const safe = escapeRegex(q);
      filter.$or = [
        { email: { $regex: safe, $options: "i" } },
        { name: { $regex: safe, $options: "i" } },
        { displayName: { $regex: safe, $options: "i" } },
        { display_name: { $regex: safe, $options: "i" } },
      ];
    }

    if (status === "blocked") filter.isBlocked = true;
    if (status === "banned") filter.isBanned = true;
    if (status === "active") {
      filter.isBlocked = { $ne: true };
      filter.isBanned = { $ne: true };
    }

    const [total, rows, totalHosts, blockedHosts, bannedHosts, stripeConnectedHosts] = await Promise.all([
      User.countDocuments(filter),
      User.find(filter)
        .select(
          [
            "name",
            "displayName",
            "display_name",
            "email",
            "role",
            "isBlocked",
            "isBanned",
            "emailVerified",
            "phoneVerified",
            "phone",
            "phoneCountryCode",
            "city",
            "country",
            "stripeAccountId",
            "isStripeChargesEnabled",
            "isStripePayoutsEnabled",
            "isStripeDetailsSubmitted",
            "accountDeletionStatus",
            "accountDeletionRequestedAt",
            "accountDeletionScheduledAt",
            "total_participants",
            "total_events",
            "lastAuthAt",
            "createdAt",
            "updatedAt",
          ].join(" ")
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments({ role: { $in: ["HOST", "BOTH"] } }),
      User.countDocuments({ role: { $in: ["HOST", "BOTH"] }, isBlocked: true }),
      User.countDocuments({ role: { $in: ["HOST", "BOTH"] }, isBanned: true }),
      User.countDocuments({ role: { $in: ["HOST", "BOTH"] }, stripeAccountId: { $nin: [null, ""] } }),
    ]);

    const hostIds = rows.map((row) => row._id);

    const [complianceMapRaw, experienceStatsRaw, bookingStatsRaw, participantsRaw, reportsRaw] = await Promise.all([
      getLatestHostComplianceMap(hostIds.map((id) => String(id))),
      hostIds.length
        ? Experience.aggregate([
            { $match: { host: { $in: hostIds } } },
            {
              $group: {
                _id: "$host",
                total: { $sum: 1 },
                active: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $eq: [{ $toUpper: { $ifNull: ["$status", ""] } }, "PUBLISHED"] },
                          { $gte: [{ $ifNull: ["$endsAt", new Date(0)] }, now] },
                        ],
                      },
                      1,
                      0,
                    ],
                  },
                },
                upcoming: {
                  $sum: {
                    $cond: [
                      { $gte: [{ $ifNull: ["$startsAt", new Date(0)] }, now] },
                      1,
                      0,
                    ],
                  },
                },
              },
            },
          ])
        : [],
      hostIds.length
        ? Booking.aggregate([
            { $match: { host: { $in: hostIds } } },
            {
              $group: {
                _id: "$host",
                total: { $sum: 1 },
                paidLike: {
                  $sum: {
                    $cond: [{ $in: ["$status", adminBookingPaidStatuses] }, 1, 0],
                  },
                },
                disputed: {
                  $sum: {
                    $cond: [{ $eq: ["$status", "DISPUTED"] }, 1, 0],
                  },
                },
              },
            },
          ])
        : [],
      hostIds.length
        ? Booking.aggregate([
            {
              $match: {
                host: { $in: hostIds },
                status: { $in: adminParticipantStatuses },
              },
            },
            {
              $group: {
                _id: "$host",
                participants: { $sum: { $ifNull: ["$quantity", 1] } },
              },
            },
          ])
        : [],
      hostIds.length
        ? Report.aggregate([
            { $match: { host: { $in: hostIds } } },
            {
              $group: {
                _id: "$host",
                total: { $sum: 1 },
                open: { $sum: { $cond: [{ $eq: ["$status", "OPEN"] }, 1, 0] } },
                investigating: { $sum: { $cond: [{ $eq: ["$status", "INVESTIGATING"] }, 1, 0] } },
              },
            },
          ])
        : [],
    ]);
    const complianceMap = await ensureComplianceMapHasStripeData(rows, complianceMapRaw, "admin.hosts.list");

    const experienceStatsByHost = new Map(experienceStatsRaw.map((row) => [String(row._id), row]));
    const bookingStatsByHost = new Map(bookingStatsRaw.map((row) => [String(row._id), row]));
    const participantsByHost = new Map(participantsRaw.map((row) => [String(row._id), Number(row.participants || 0)]));
    const reportsByHost = new Map(reportsRaw.map((row) => [String(row._id), row]));

    const items = rows.map((row) => {
      const id = String(row._id);
      const snapshot = complianceMap.get(id) || null;
      const hostBase = serializeAdminComplianceHost(row, snapshot);
      const expStats = experienceStatsByHost.get(id) || {};
      const bookingStats = bookingStatsByHost.get(id) || {};
      const reportStats = reportsByHost.get(id) || {};
      return {
        ...hostBase,
        phone: row.phone || "",
        phoneCountryCode: row.phoneCountryCode || "",
        phoneVerified: !!row.phoneVerified,
        city: row.city || "",
        country: row.country || "",
        accountDeletionStatus: row.accountDeletionStatus || "NONE",
        accountDeletionRequestedAt: row.accountDeletionRequestedAt || null,
        accountDeletionScheduledAt: row.accountDeletionScheduledAt || null,
        lastAuthAt: row.lastAuthAt || null,
        counts: {
          experiencesTotal: Number(expStats.total || 0),
          experiencesActive: Number(expStats.active || 0),
          experiencesUpcoming: Number(expStats.upcoming || 0),
          bookingsTotal: Number(bookingStats.total || 0),
          bookingsPaidLike: Number(bookingStats.paidLike || 0),
          bookingsDisputed: Number(bookingStats.disputed || 0),
          participantsHosted: Number(participantsByHost.get(id) || 0),
          reportsTotal: Number(reportStats.total || 0),
          reportsOpen: Number(reportStats.open || 0),
          reportsInvestigating: Number(reportStats.investigating || 0),
        },
      };
    });

    const complianceAttentionInPage = items.filter((item) => (item.issues || []).length > 0).length;

    return res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      summary: {
        totalHosts,
        blockedHosts,
        bannedHosts,
        stripeConnectedHosts,
        complianceAttentionInPage,
      },
      items,
    });
  } catch (err) {
    console.error("Admin hosts list error", err);
    return res.status(500).json({ message: "Failed to load hosts" });
  }
});

router.get("/hosts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const forceSync = parseBoolFilter(req.query?.sync) === true;
    if (!isObjectIdLike(id)) {
      return res.status(400).json({ message: "Invalid host id" });
    }
    const hostObjectId = new mongoose.Types.ObjectId(id);
    const host = await User.findById(hostObjectId)
      .select(
        [
          "name",
          "displayName",
          "display_name",
          "email",
          "role",
          "isBlocked",
          "isBanned",
          "emailVerified",
          "phoneVerified",
          "phone",
          "phoneCountryCode",
          "city",
          "country",
          "languages",
          "about_me",
          "shortBio",
          "experience",
          "stripeAccountId",
          "isStripeChargesEnabled",
          "isStripePayoutsEnabled",
          "isStripeDetailsSubmitted",
          "hostFeeMode",
          "hostStripeFeePercentBps",
          "hostStripeFeeFixedMinor",
          "accountDeletionStatus",
          "accountDeletionRequestedAt",
          "accountDeletionScheduledAt",
          "tokenVersion",
          "lastAuthAt",
          "total_participants",
          "total_events",
          "rating_avg",
          "rating_count",
          "createdAt",
          "updatedAt",
          "hostProfile",
        ].join(" ")
      )
      .lean();

    if (!host || !["HOST", "BOTH"].includes(String(host.role || "").toUpperCase())) {
      return res.status(404).json({ message: "Host not found" });
    }

    const now = new Date();
    let complianceSyncWarning = "";
    let complianceSnapshot = await HostComplianceSnapshot.findOne({ user: hostObjectId }).sort({ createdAt: -1 }).lean();
    if (host.stripeAccountId && (!complianceSnapshot || forceSync)) {
      const syncResult = await syncHostComplianceSnapshotSafe(
        hostObjectId,
        forceSync ? "admin.hosts.details.force_sync" : "admin.hosts.details"
      );
      if (syncResult?.snapshot) {
        complianceSnapshot = syncResult.snapshot;
      } else if (syncResult?.error) {
        complianceSyncWarning = syncResult.error;
      }
    }

    const [
      complianceHistoryRaw,
      experiencesTotal,
      experiencesActive,
      experiencesUpcoming,
      experiencesCompleted,
      bookingsTotal,
      bookingsPaidLike,
      bookingsDisputed,
      bookingsRefundFailed,
      participantsHostedAgg,
      reportsTotal,
      reportsOpen,
      reportsInvestigating,
      paymentsDisputed,
      messagesSent,
      recentExperiencesRaw,
      recentBookingsRaw,
      recentReportsRaw,
    ] = await Promise.all([
      HostComplianceSnapshot.find({ user: hostObjectId })
        .sort({ createdAt: -1 })
        .limit(10)
        .select(
          "createdAt nameMatchState livadaiName stripeLegalName stripeDisplayName stripeNameSource stripeBusinessType bankName bankLast4 bankCountry bankCurrency bankReferenceSource requirementsDisabledReason requirementsCurrentlyDue isStripeChargesEnabled isStripePayoutsEnabled isStripeDetailsSubmitted triggerType triggerEventType"
        )
        .lean(),
      Experience.countDocuments({ host: hostObjectId }),
      Experience.countDocuments({
        host: hostObjectId,
        status: { $regex: /^published$/i },
        endsAt: { $gte: now },
      }),
      Experience.countDocuments({ host: hostObjectId, startsAt: { $gte: now } }),
      Experience.countDocuments({ host: hostObjectId, endsAt: { $lt: now } }),
      Booking.countDocuments({ host: hostObjectId }),
      Booking.countDocuments({ host: hostObjectId, status: { $in: adminBookingPaidStatuses } }),
      Booking.countDocuments({ host: hostObjectId, status: "DISPUTED" }),
      Booking.countDocuments({ host: hostObjectId, status: "REFUND_FAILED" }),
      Booking.aggregate([
        {
          $match: {
            host: hostObjectId,
            status: { $in: adminParticipantStatuses },
          },
        },
        {
          $group: {
            _id: null,
            participants: { $sum: { $ifNull: ["$quantity", 1] } },
          },
        },
      ]),
      Report.countDocuments({ host: hostObjectId }),
      Report.countDocuments({ host: hostObjectId, status: "OPEN" }),
      Report.countDocuments({ host: hostObjectId, status: "INVESTIGATING" }),
      Payment.countDocuments({ host: hostObjectId, status: { $in: ["DISPUTED", "DISPUTE_LOST"] } }),
      Message.countDocuments({ sender: hostObjectId }),
      Experience.find({ host: hostObjectId })
        .sort({ createdAt: -1 })
        .limit(12)
        .populate("host", "name displayName display_name email")
        .lean(),
      Booking.find({ host: hostObjectId })
        .populate("host", "name displayName display_name email")
        .populate("explorer", "name displayName display_name email")
        .populate("experience", "title startsAt endsAt startDate endDate city country price isActive status")
        .sort({ createdAt: -1 })
        .limit(12)
        .lean(),
      Report.find({ host: hostObjectId })
        .populate("reporter", "name displayName display_name email")
        .populate("host", "name displayName display_name email")
        .populate("targetUserId", "name displayName display_name email isBlocked isBanned")
        .populate("experience", "title status isActive city country")
        .populate("booking", "status quantity")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    const experienceIds = recentExperiencesRaw.map((row) => row._id);
    const participantsByExperienceRaw = experienceIds.length
      ? await Booking.aggregate([
          {
            $match: {
              experience: { $in: experienceIds },
              status: { $in: adminParticipantStatuses },
            },
          },
          {
            $group: {
              _id: "$experience",
              participants: { $sum: { $ifNull: ["$quantity", 1] } },
            },
          },
        ])
      : [];
    const participantsByExperience = new Map(
      participantsByExperienceRaw.map((row) => [String(row._id), Number(row.participants || 0)])
    );

    const bookingIds = recentBookingsRaw.map((row) => row._id);
    const bookingPayments = bookingIds.length
      ? await Payment.find({ booking: { $in: bookingIds } })
          .select("booking status paymentType amount totalAmount currency stripePaymentIntentId stripeSessionId")
          .sort({ createdAt: -1 })
          .lean()
      : [];
    const paymentByBooking = new Map();
    for (const p of bookingPayments) {
      const key = String(p.booking);
      if (paymentByBooking.has(key)) continue;
      paymentByBooking.set(key, {
        status: p.status || "",
        paymentType: p.paymentType || "",
        amount: Number(p.totalAmount || p.amount || 0),
        currency: p.currency || "ron",
        hasStripePaymentIntent: !!p.stripePaymentIntentId,
        stripeSessionId: p.stripeSessionId || null,
      });
    }

    const hostPayload = {
      ...serializeAdminComplianceHost(host, complianceSnapshot || null),
      phone: host.phone || "",
      phoneCountryCode: host.phoneCountryCode || "",
      phoneVerified: !!host.phoneVerified,
      city: host.city || "",
      country: host.country || "",
      emailVerified: !!host.emailVerified,
      languages: Array.isArray(host.languages) ? host.languages : [],
      aboutMe: host.about_me || "",
      shortBio: host.shortBio || "",
      experience: host.experience || "",
      tokenVersion: Number(host.tokenVersion || 0),
      lastAuthAt: host.lastAuthAt || null,
      accountDeletionStatus: host.accountDeletionStatus || "NONE",
      accountDeletionRequestedAt: host.accountDeletionRequestedAt || null,
      accountDeletionScheduledAt: host.accountDeletionScheduledAt || null,
      totalParticipants: Number(host.total_participants || 0),
      totalEvents: Number(host.total_events || 0),
      ratingAvg: Number(host.rating_avg || 0),
      ratingCount: Number(host.rating_count || 0),
      hostProfile: host.hostProfile || null,
      complianceHistory: complianceHistoryRaw.map((row) => ({
        id: String(row._id),
        snapshotAt: row.createdAt || null,
        triggerType: row.triggerType || "",
        triggerEventType: row.triggerEventType || "",
        nameMatchState: row.nameMatchState || "",
        livadaiName: row.livadaiName || "",
        stripeLegalName: row.stripeLegalName || "",
        stripeDisplayName: row.stripeDisplayName || "",
        stripeNameSource: row.stripeNameSource || "",
        stripeBusinessType: row.stripeBusinessType || "",
        bankName: row.bankName || "",
        bankLast4: row.bankLast4 || "",
        bankCountry: row.bankCountry || "",
        bankCurrency: row.bankCurrency || "",
        bankReferenceSource: row.bankReferenceSource || "",
        requirementsDisabledReason: row.requirementsDisabledReason || "",
        requirementsCurrentlyDueCount: Number(row.requirementsCurrentlyDue?.length || 0),
        stripeFlags: {
          chargesEnabled: !!row.isStripeChargesEnabled,
          payoutsEnabled: !!row.isStripePayoutsEnabled,
          detailsSubmitted: !!row.isStripeDetailsSubmitted,
        },
      })),
    };

    return res.json({
      host: hostPayload,
      counts: {
        experiencesTotal,
        experiencesActive,
        experiencesUpcoming,
        experiencesCompleted,
        bookingsTotal,
        bookingsPaidLike,
        bookingsDisputed,
        bookingsRefundFailed,
        participantsHosted: Number(participantsHostedAgg?.[0]?.participants || 0),
        reportsTotal,
        reportsOpen,
        reportsInvestigating,
        paymentsDisputed,
        messagesSent,
      },
      recentExperiences: recentExperiencesRaw.map((row) => serializeAdminExperience(row, participantsByExperience)),
      recentBookings: recentBookingsRaw.map((row) =>
        serializeAdminBooking(row, {
          payment: paymentByBooking.get(String(row._id)) || null,
        })
      ),
      recentReports: recentReportsRaw.map((row) => serializeAdminReport(row, { now })),
      complianceSyncWarning: complianceSyncWarning || "",
    });
  } catch (err) {
    console.error("Admin host details error", err);
    return res.status(500).json({ message: "Failed to load host details" });
  }
});

router.patch("/hosts/:id/fee-policy", requireOwnerAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectIdLike(id)) {
      return res.status(400).json({ message: "Invalid host id" });
    }

    const reason = String(req.adminReason || req.body?.reason || "").trim();
    if (!reason) {
      return res.status(400).json({ message: "Reason is required" });
    }

    const nextMode = normalizeHostFeeMode(req.body?.feeMode);
    if (![HOST_FEE_MODES.STANDARD, HOST_FEE_MODES.HOST_PAYS_STRIPE].includes(nextMode)) {
      return res.status(400).json({ message: "Invalid fee mode" });
    }

    const host = await User.findById(id);
    if (!host || !["HOST", "BOTH"].includes(normalizeRole(host.role))) {
      return res.status(404).json({ message: "Host not found" });
    }

    const before = {
      hostFeeMode: normalizeHostFeeMode(host.hostFeeMode),
      hostStripeFeePercentBps: Number(host.hostStripeFeePercentBps || 0),
      hostStripeFeeFixedMinor: Number(host.hostStripeFeeFixedMinor || 0),
    };

    if (nextMode === HOST_FEE_MODES.HOST_PAYS_STRIPE) {
      const config = getGlobalHostPaysStripeConfig();
      if (!config.configured) {
        return res.status(400).json({
          message:
            "Host pays Stripe fee is not configured. Set STRIPE_HOST_PAYS_FEE_PERCENT_BPS and STRIPE_HOST_PAYS_FEE_FIXED_MINOR first.",
        });
      }
      host.hostFeeMode = HOST_FEE_MODES.HOST_PAYS_STRIPE;
      host.hostStripeFeePercentBps = config.percentBps;
      host.hostStripeFeeFixedMinor = config.fixedMinor;
    } else {
      host.hostFeeMode = HOST_FEE_MODES.STANDARD;
      host.hostStripeFeePercentBps = 0;
      host.hostStripeFeeFixedMinor = 0;
    }

    await host.save();

    await writeAdminAuditLog(req, {
      actionType: "HOST_FEE_POLICY_UPDATE",
      targetType: "host",
      targetId: String(host._id),
      reason,
      diff: {
        before,
        after: {
          hostFeeMode: normalizeHostFeeMode(host.hostFeeMode),
          hostStripeFeePercentBps: Number(host.hostStripeFeePercentBps || 0),
          hostStripeFeeFixedMinor: Number(host.hostStripeFeeFixedMinor || 0),
        },
      },
    });

    return res.json({
      message: "Host fee policy updated",
      feePolicy: buildAdminHostFeePolicy(host),
    });
  } catch (err) {
    console.error("Admin host fee policy update error", err);
    return res.status(500).json({ message: "Failed to update host fee policy" });
  }
});

router.get("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectIdLike(id)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const user = await User.findById(id)
      .select(
        [
          "name",
          "displayName",
          "display_name",
          "email",
          "role",
          "isBlocked",
          "isBanned",
          "emailVerified",
          "phoneVerified",
          "city",
          "country",
          "languages",
          "about_me",
          "shortBio",
          "experience",
          "phone",
          "phoneCountryCode",
          "total_participants",
          "total_events",
          "isTrustedParticipant",
          "clientFaultCancelsCount",
          "stripeAccountId",
          "isStripeChargesEnabled",
          "isStripePayoutsEnabled",
          "isStripeDetailsSubmitted",
          "tokenVersion",
          "lastAuthAt",
          "rating_avg",
          "rating_count",
          "createdAt",
          "updatedAt",
          "hostProfile",
        ].join(" ")
      )
      .lean();

    if (!user) return res.status(404).json({ message: "User not found" });

    const userObjectId = new mongoose.Types.ObjectId(id);

    const [
      bookingsAsExplorerCount,
      bookingsAsHostCount,
      experiencesCount,
      reportsCreatedCount,
      reportsAgainstCount,
      messagesSentCount,
      recentBookingsRaw,
      recentExperiencesRaw,
      recentReportsRaw,
      recentAuditRaw,
    ] = await Promise.all([
      Booking.countDocuments({ explorer: userObjectId }),
      Booking.countDocuments({ host: userObjectId }),
      Experience.countDocuments({ host: userObjectId }),
      Report.countDocuments({ reporter: userObjectId }),
      Report.countDocuments({ targetUserId: userObjectId }),
      Message.countDocuments({ sender: userObjectId }),
      Booking.find({ $or: [{ explorer: userObjectId }, { host: userObjectId }] })
        .populate("host", "name displayName display_name email")
        .populate("explorer", "name displayName display_name email")
        .populate("experience", "title startsAt endsAt startDate endDate city country price isActive status")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Experience.find({ host: userObjectId })
        .populate("host", "name displayName display_name email")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Report.find({
        $or: [{ reporter: userObjectId }, { host: userObjectId }, { targetUserId: userObjectId }],
      })
        .populate("reporter", "name displayName display_name email")
        .populate("host", "name displayName display_name email")
        .populate("targetUserId", "name displayName display_name email isBlocked isBanned")
        .populate("experience", "title status isActive city country")
        .populate("booking", "status quantity")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      AdminAuditLog.find({
        $or: [{ targetType: "user", targetId: String(id) }, { actorId: String(id) }],
      })
        .sort({ createdAt: -1 })
        .limit(12)
        .lean(),
    ]);

    const bookingIds = recentBookingsRaw.map((row) => row._id);
    const bookingPayments = bookingIds.length
      ? await Payment.find({ booking: { $in: bookingIds } })
          .select("booking status paymentType amount totalAmount currency stripePaymentIntentId stripeSessionId")
          .sort({ createdAt: -1 })
          .lean()
      : [];

    const paymentByBooking = new Map();
    for (const p of bookingPayments) {
      const key = String(p.booking);
      if (paymentByBooking.has(key)) continue;
      paymentByBooking.set(key, {
        status: p.status || "",
        paymentType: p.paymentType || "",
        amount: Number(p.totalAmount || p.amount || 0),
        currency: p.currency || "ron",
        hasStripePaymentIntent: !!p.stripePaymentIntentId,
        stripeSessionId: p.stripeSessionId || null,
      });
    }

    const recentBookings = recentBookingsRaw.map((row) =>
      serializeAdminBooking(row, {
        payment: paymentByBooking.get(String(row._id)) || null,
      })
    );
    const recentExperiences = recentExperiencesRaw.map((row) => serializeAdminExperience(row));
    const recentReports = recentReportsRaw.map((row) => serializeAdminReport(row, { now: new Date() }));
    const recentAudit = recentAuditRaw.map((row) => ({
      id: String(row._id),
      actorId: row.actorId ? String(row.actorId) : "",
      actorEmail: row.actorEmail || "",
      actionType: row.actionType || "",
      targetType: row.targetType || "",
      targetId: row.targetId || "",
      reason: row.reason || "",
      diff: row.diff || null,
      meta: row.meta || null,
      ip: row.ip || "",
      userAgent: row.userAgent || "",
      createdAt: row.createdAt || null,
    }));

    const timeline = [
      { kind: "USER_CREATED", at: user.createdAt || null, label: "Cont creat" },
      ...recentBookings.map((b) => ({
        kind: "BOOKING",
        at: b.createdAt || null,
        label: `${b.status || "BOOKING"} · ${b.experience?.title || "Experiență"}`,
        targetId: b.id,
      })),
      ...recentExperiences.map((e) => ({
        kind: "EXPERIENCE",
        at: e.createdAt || null,
        label: `${e.status || "experience"} · ${e.title || "Fără titlu"}`,
        targetId: e.id,
      })),
      ...recentReports.map((r) => ({
        kind: "REPORT",
        at: r.createdAt || null,
        label: `${r.status || "REPORT"} · ${r.type || "REPORT"}`,
        targetId: r.id,
      })),
      ...recentAudit.map((a) => ({
        kind: "ADMIN_AUDIT",
        at: a.createdAt || null,
        label: `${a.actionType || "ACTION"} (${a.actorEmail || "admin"})`,
        targetId: a.id,
      })),
    ]
      .filter((row) => row.at)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 20);

    return res.json({
      user: {
        ...serializeAdminUser(user),
        phone: user.phone || "",
        phoneCountryCode: user.phoneCountryCode || "",
        phoneVerified: !!user.phoneVerified,
        languages: Array.isArray(user.languages) ? user.languages : [],
        aboutMe: user.about_me || "",
        shortBio: user.shortBio || "",
        experience: user.experience || "",
        tokenVersion: Number(user.tokenVersion || 0),
        lastAuthAt: user.lastAuthAt || null,
        isTrustedParticipant: !!user.isTrustedParticipant,
        clientFaultCancelsCount: Number(user.clientFaultCancelsCount || 0),
        totalParticipants: Number(user.total_participants || 0),
        totalEvents: Number(user.total_events || 0),
        ratingAvg: Number(user.rating_avg || 0),
        ratingCount: Number(user.rating_count || 0),
        stripe: {
          accountId: user.stripeAccountId || null,
          connected: !!user.stripeAccountId,
          chargesEnabled: !!user.isStripeChargesEnabled,
          payoutsEnabled: !!user.isStripePayoutsEnabled,
          detailsSubmitted: !!user.isStripeDetailsSubmitted,
        },
        hostProfile: user.hostProfile || null,
      },
      counts: {
        bookingsAsExplorer: bookingsAsExplorerCount,
        bookingsAsHost: bookingsAsHostCount,
        bookingsTotal: bookingsAsExplorerCount + bookingsAsHostCount,
        experiencesHosted: experiencesCount,
        reportsCreated: reportsCreatedCount,
        reportsAgainstUser: reportsAgainstCount,
        messagesSent: messagesSentCount,
      },
      recentBookings,
      recentExperiences,
      recentReports,
      recentAudit,
      timeline,
    });
  } catch (err) {
    console.error("Admin user details error", err);
    return res.status(500).json({ message: "Failed to load user details" });
  }
});

router.patch("/users/:id", requireAdminCapability(ADMIN_CAPABILITIES.USERS_WRITE), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !id.match(/^[a-f\d]{24}$/i)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const { role, isBlocked, isBanned, invalidateSessions } = req.body || {};
    const reason = String(req.adminReason || req.body?.reason || "").trim();
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: "User not found" });
    const actorHasOwnerWrite = hasOwnerWrite(req.user?.role);
    const targetRoleBefore = normalizeRole(user.role);
    const targetIsAdminBefore = isAdminRole(targetRoleBefore);
    const before = {
      role: user.role,
      isHost: !!user.isHost,
      isBlocked: !!user.isBlocked,
      isBanned: !!user.isBanned,
      tokenVersion: user.tokenVersion || 0,
    };
    const diff = {};

    if (typeof role === "string") {
      const nextRole = normalizeRole(role);
      if (!allowedUserRoles.includes(nextRole)) {
        return res.status(400).json({ message: "Invalid role" });
      }
      const nextIsAdmin = isAdminRole(nextRole);
      if ((targetIsAdminBefore || nextIsAdmin) && !actorHasOwnerWrite) {
        return res.status(403).json({ message: "Only owner admin can manage admin roles" });
      }
      if (user.role !== nextRole) {
        diff.role = { from: user.role, to: nextRole };
      }
      user.role = nextRole;
      user.isHost = nextRole === "HOST" || nextRole === "BOTH";
    }
    if (
      targetIsAdminBefore &&
      !actorHasOwnerWrite &&
      (typeof isBlocked === "boolean" || typeof isBanned === "boolean" || invalidateSessions === true)
    ) {
      return res.status(403).json({ message: "Only owner admin can modify another admin account" });
    }
    if (typeof isBlocked === "boolean") {
      if (!!user.isBlocked !== isBlocked) {
        diff.isBlocked = { from: !!user.isBlocked, to: isBlocked };
      }
      user.isBlocked = isBlocked;
    }
    if (typeof isBanned === "boolean") {
      if (!!user.isBanned !== isBanned) {
        diff.isBanned = { from: !!user.isBanned, to: isBanned };
      }
      user.isBanned = isBanned;
      if (isBanned) user.isBlocked = true;
    }
    if (invalidateSessions === true) {
      diff.tokenVersion = { from: user.tokenVersion || 0, to: (user.tokenVersion || 0) + 1 };
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }

    const criticalUserAction = typeof isBlocked === "boolean" || typeof isBanned === "boolean";
    if (criticalUserAction && !reason) {
      return res.status(400).json({ message: "Reason is required for block/ban actions" });
    }

    await user.save();
    await writeAdminAuditLog(req, {
      actionType:
        typeof isBanned === "boolean"
          ? isBanned
            ? "USER_BAN"
            : "USER_UNBAN"
          : typeof isBlocked === "boolean"
            ? isBlocked
              ? "USER_BLOCK"
              : "USER_UNBLOCK"
            : invalidateSessions === true
              ? "USER_INVALIDATE_SESSIONS"
              : "USER_UPDATE",
      targetType: "user",
      targetId: String(user._id),
      reason: reason || undefined,
      diff: Object.keys(diff).length ? diff : { before },
    });
    return res.json({ message: "User updated", user: serializeAdminUser(user) });
  } catch (err) {
    console.error("Admin user update error", err);
    return res.status(500).json({ message: "Failed to update user" });
  }
});

router.get("/experiences", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const active = parseBoolFilter(req.query.active);
    const limit = clampLimit(req.query.limit, 20, 100);
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const skip = (page - 1) * limit;

    const filter = {};
    if (typeof active === "boolean") filter.isActive = active;
    if (status && status !== "all") filter.status = status;
    if (q) {
      const safe = escapeRegex(q);
      filter.$or = [
        { title: { $regex: safe, $options: "i" } },
        { city: { $regex: safe, $options: "i" } },
        { country: { $regex: safe, $options: "i" } },
        { address: { $regex: safe, $options: "i" } },
      ];
    }

    const [total, rows] = await Promise.all([
      Experience.countDocuments(filter),
      Experience.find(filter)
        .select("host title status isActive price environment city country startsAt endsAt startDate endDate maxParticipants remainingSpots soldOut createdAt updatedAt")
        .populate("host", "name displayName display_name email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const ids = rows.map((r) => r._id);
    const bookingsAgg = ids.length
      ? await Booking.aggregate([
          {
            $match: {
              experience: { $in: ids },
              status: { $in: adminParticipantStatuses },
            },
          },
          {
            $group: {
              _id: "$experience",
              participants: { $sum: { $ifNull: ["$quantity", 1] } },
            },
          },
        ])
      : [];
    const participantsByExperience = new Map(bookingsAgg.map((row) => [String(row._id), Number(row.participants || 0)]));

    return res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      items: rows.map((row) => serializeAdminExperience(row, participantsByExperience)),
    });
  } catch (err) {
    console.error("Admin experiences list error", err);
    return res.status(500).json({ message: "Failed to load experiences" });
  }
});

router.post("/experiences/bulk-action", requireAdminCapability(ADMIN_CAPABILITIES.EXPERIENCES_WRITE), async (req, res) => {
  try {
    const action = String(req.body?.action || "").trim().toUpperCase();
    const idsRaw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const reason = String(req.adminReason || req.body?.reason || "").trim();

    const ids = [...new Set(idsRaw.map((id) => String(id || "").trim()).filter(Boolean))];
    if (!ids.length) {
      return res.status(400).json({ message: "No experience ids provided" });
    }
    if (ids.length > 100) {
      return res.status(400).json({ message: "Bulk action limit is 100 experiences" });
    }
    if (!["PAUSE", "UNPAUSE"].includes(action)) {
      return res.status(400).json({ message: "Invalid bulk action" });
    }
    if (action === "PAUSE" && !reason) {
      return res.status(400).json({ message: "Reason is required for PAUSE" });
    }

    const invalidIds = ids.filter((id) => !isObjectIdLike(id));
    if (invalidIds.length) {
      return res.status(400).json({ message: "Invalid experience ids in payload", invalidIds });
    }

    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
    const experiences = await Experience.find({ _id: { $in: objectIds } }).populate("host", "email name displayName display_name");
    const byId = new Map(experiences.map((exp) => [String(exp._id), exp]));
    const batchId = `exp-bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const updated = [];
    const skipped = [];

    for (const id of ids) {
      const exp = byId.get(id);
      if (!exp) {
        skipped.push({ id, reason: "NOT_FOUND" });
        continue;
      }

      const before = {
        isActive: exp.isActive !== false,
        status: exp.status || "",
        soldOut: !!exp.soldOut,
        remainingSpots: Number(exp.remainingSpots ?? 0),
      };
      const diff = {};

      if (action === "PAUSE") {
        if (exp.isActive === false && String(exp.status || "").toUpperCase() === "DISABLED") {
          skipped.push({ id, reason: "ALREADY_PAUSED" });
          continue;
        }
        if ((exp.isActive !== false) !== false) diff.isActive = { from: exp.isActive !== false, to: false };
        if (String(exp.status || "") !== "DISABLED") diff.status = { from: exp.status || "", to: "DISABLED" };
        if (!!exp.soldOut !== true) diff.soldOut = { from: !!exp.soldOut, to: true };
        if (Number(exp.remainingSpots ?? 0) !== 0) diff.remainingSpots = { from: Number(exp.remainingSpots ?? 0), to: 0 };

        exp.isActive = false;
        exp.status = "DISABLED";
        exp.soldOut = true;
        exp.remainingSpots = 0;
      }

      if (action === "UNPAUSE") {
        const prevActive = exp.isActive !== false;
        if (prevActive && String(exp.status || "").toUpperCase() !== "DISABLED") {
          skipped.push({ id, reason: "ALREADY_ACTIVE" });
          continue;
        }
        if (prevActive !== true) diff.isActive = { from: prevActive, to: true };
        exp.isActive = true;
        if (String(exp.status || "").toUpperCase() === "DISABLED") {
          diff.status = { from: exp.status || "", to: "published" };
          exp.status = "published";
        }
        const max = Number(exp.maxParticipants || 0);
        const rem = Number(exp.remainingSpots || 0);
        const nextSoldOut = max > 0 ? rem <= 0 : false;
        if (!!exp.soldOut !== nextSoldOut) diff.soldOut = { from: !!exp.soldOut, to: nextSoldOut };
        exp.soldOut = nextSoldOut;
      }

      await exp.save();
      updated.push(String(exp._id));
      await writeAdminAuditLog(req, {
        actionType: action === "PAUSE" ? "EXPERIENCE_BULK_PAUSE" : "EXPERIENCE_BULK_UNPAUSE",
        targetType: "experience",
        targetId: String(exp._id),
        reason: reason || undefined,
        diff: Object.keys(diff).length ? diff : { before },
        meta: {
          batchId,
          hostId: exp.host?._id ? String(exp.host._id) : undefined,
          hostEmail: exp.host?.email || undefined,
        },
      });
    }

    await writeAdminAuditLog(req, {
      actionType: action === "PAUSE" ? "EXPERIENCE_BULK_PAUSE_SUMMARY" : "EXPERIENCE_BULK_UNPAUSE_SUMMARY",
      targetType: "experience_bulk",
      targetId: batchId,
      reason: reason || undefined,
      diff: {
        idsRequested: ids.length,
        updatedCount: updated.length,
        skippedCount: skipped.length,
      },
      meta: {
        ids,
        updated,
        skipped,
      },
    });

    return res.json({
      message: "Bulk action completed",
      action,
      batchId,
      requestedCount: ids.length,
      updatedCount: updated.length,
      skippedCount: skipped.length,
      updatedIds: updated,
      skipped,
    });
  } catch (err) {
    console.error("Admin experiences bulk action error", err);
    return res.status(500).json({ message: "Failed to run experience bulk action" });
  }
});

router.get("/experiences/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectIdLike(id)) {
      return res.status(400).json({ message: "Invalid experience id" });
    }

    const exp = await Experience.findById(id)
      .select(
        [
          "host",
          "title",
          "shortDescription",
          "description",
          "category",
          "price",
          "durationMinutes",
          "currencyCode",
          "activityType",
          "maxParticipants",
          "remainingSpots",
          "soldOut",
          "status",
          "environment",
          "startsAt",
          "endsAt",
          "startDate",
          "endDate",
          "country",
          "countryCode",
          "city",
          "street",
          "streetNumber",
          "address",
          "latitude",
          "longitude",
          "locationLat",
          "locationLng",
          "location",
          "mainImageUrl",
          "coverImageUrl",
          "images",
          "videos",
          "mediaRefs",
          "languages",
          "isActive",
          "reminderHostSent",
          "mediaCleanedAt",
          "createdAt",
          "updatedAt",
        ].join(" ")
      )
      .populate("host", "name displayName display_name email stripeAccountId isStripeChargesEnabled isStripePayoutsEnabled isStripeDetailsSubmitted")
      .lean();

    if (!exp) return res.status(404).json({ message: "Experience not found" });

    const expObjectId = new mongoose.Types.ObjectId(id);

    const [
      bookingsTotal,
      bookingsActive,
      bookingsPaidLike,
      participantsAgg,
      reportsTotal,
      reportsOpen,
      messagesCount,
      recentBookingsRaw,
      recentReportsRaw,
      recentAuditRaw,
    ] = await Promise.all([
      Booking.countDocuments({ experience: expObjectId }),
      Booking.countDocuments({ experience: expObjectId, status: { $in: adminBookingActiveStatuses } }),
      Booking.countDocuments({ experience: expObjectId, status: { $in: adminBookingPaidStatuses } }),
      Booking.aggregate([
        { $match: { experience: expObjectId, status: { $in: adminParticipantStatuses } } },
        { $group: { _id: null, participants: { $sum: { $ifNull: ["$quantity", 1] } } } },
      ]),
      Report.countDocuments({ experience: expObjectId }),
      Report.countDocuments({ experience: expObjectId, status: { $in: ["OPEN", "INVESTIGATING"] } }),
      Message.aggregate([
        {
          $lookup: {
            from: "bookings",
            localField: "booking",
            foreignField: "_id",
            as: "bookingDoc",
          },
        },
        { $unwind: "$bookingDoc" },
        { $match: { "bookingDoc.experience": expObjectId } },
        { $count: "count" },
      ]),
      Booking.find({ experience: expObjectId })
        .populate("host", "name displayName display_name email")
        .populate("explorer", "name displayName display_name email")
        .populate("experience", "title startsAt endsAt startDate endDate city country price isActive status")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      Report.find({ experience: expObjectId })
        .populate("reporter", "name displayName display_name email")
        .populate("host", "name displayName display_name email")
        .populate("targetUserId", "name displayName display_name email isBlocked isBanned")
        .populate("experience", "title status isActive city country")
        .populate("booking", "status quantity")
        .sort({ createdAt: -1 })
        .limit(8)
        .lean(),
      AdminAuditLog.find({ targetType: "experience", targetId: String(id) })
        .sort({ createdAt: -1 })
        .limit(12)
        .lean(),
    ]);

    const bookingIds = recentBookingsRaw.map((row) => row._id);
    const [bookingPayments, bookingReportsAgg, bookingMessagesAgg] = bookingIds.length
      ? await Promise.all([
          Payment.find({ booking: { $in: bookingIds } })
            .select("booking status paymentType amount totalAmount currency stripePaymentIntentId stripeSessionId")
            .sort({ createdAt: -1 })
            .lean(),
          Report.aggregate([{ $match: { booking: { $in: bookingIds } } }, { $group: { _id: "$booking", count: { $sum: 1 } } }]),
          Message.aggregate([{ $match: { booking: { $in: bookingIds } } }, { $group: { _id: "$booking", count: { $sum: 1 } } }]),
        ])
      : [[], [], []];

    const paymentByBooking = new Map();
    for (const p of bookingPayments) {
      const key = String(p.booking);
      if (paymentByBooking.has(key)) continue;
      paymentByBooking.set(key, {
        status: p.status || "",
        paymentType: p.paymentType || "",
        amount: Number(p.totalAmount || p.amount || 0),
        currency: p.currency || "ron",
        hasStripePaymentIntent: !!p.stripePaymentIntentId,
        stripeSessionId: p.stripeSessionId || null,
      });
    }
    const bookingReportsCountByBooking = new Map(bookingReportsAgg.map((row) => [String(row._id), Number(row.count || 0)]));
    const bookingMessagesCountByBooking = new Map(bookingMessagesAgg.map((row) => [String(row._id), Number(row.count || 0)]));

    const media = [];
    const seenMedia = new Set();
    const pushMedia = (url, kind, source, extra = {}) => {
      const u = String(url || "").trim();
      if (!u || seenMedia.has(u)) return;
      seenMedia.add(u);
      media.push({
        url: u,
        kind,
        source,
        ...extra,
      });
    };
    if (Array.isArray(exp.mediaRefs)) {
      for (const ref of exp.mediaRefs) {
        pushMedia(ref?.url, ref?.resourceType === "video" ? "video" : "image", "mediaRefs", {
          publicId: ref?.publicId || null,
          resourceType: ref?.resourceType || "image",
        });
      }
    }
    pushMedia(exp.coverImageUrl, "image", "coverImageUrl");
    pushMedia(exp.mainImageUrl, "image", "mainImageUrl");
    for (const url of Array.isArray(exp.images) ? exp.images : []) pushMedia(url, "image", "images");
    for (const url of Array.isArray(exp.videos) ? exp.videos : []) pushMedia(url, "video", "videos");

    const recentBookings = recentBookingsRaw.map((row) =>
      serializeAdminBooking(row, {
        payment: paymentByBooking.get(String(row._id)) || null,
        reportsCount: bookingReportsCountByBooking.get(String(row._id)) || 0,
        messagesCount: bookingMessagesCountByBooking.get(String(row._id)) || 0,
      })
    );
    const recentReports = recentReportsRaw.map((row) => serializeAdminReport(row, { now: new Date() }));
    const recentAudit = recentAuditRaw.map((row) => ({
      id: String(row._id),
      actorId: row.actorId ? String(row.actorId) : "",
      actorEmail: row.actorEmail || "",
      actionType: row.actionType || "",
      targetType: row.targetType || "",
      targetId: row.targetId || "",
      reason: row.reason || "",
      diff: row.diff || null,
      meta: row.meta || null,
      ip: row.ip || "",
      userAgent: row.userAgent || "",
      createdAt: row.createdAt || null,
    }));

    const timeline = [
      { kind: "EXPERIENCE_CREATED", at: exp.createdAt || null, label: "Experiență creată", targetId: String(exp._id) },
      ...recentBookings.map((b) => ({
        kind: "BOOKING",
        at: b.createdAt || null,
        label: `${b.status || "BOOKING"} · ${b.explorer?.email || b.explorer?.name || "explorer"}`,
        targetId: b.id,
      })),
      ...recentReports.map((r) => ({
        kind: "REPORT",
        at: r.createdAt || null,
        label: `${r.type || "REPORT"} · ${r.status || "—"}`,
        targetId: r.id,
      })),
      ...recentAudit.map((a) => ({
        kind: "ADMIN_AUDIT",
        at: a.createdAt || null,
        label: `${a.actionType || "ACTION"} (${a.actorEmail || "admin"})`,
        targetId: a.id,
      })),
    ]
      .filter((row) => row.at)
      .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
      .slice(0, 20);

    return res.json({
      experience: {
        ...serializeAdminExperience(exp),
        shortDescription: exp.shortDescription || "",
        description: exp.description || "",
        category: exp.category || "",
        durationMinutes: Number(exp.durationMinutes || 0),
        currencyCode: exp.currencyCode || "RON",
        activityType: exp.activityType || "",
        languages: Array.isArray(exp.languages) ? exp.languages : [],
        address: exp.address || exp.location?.formattedAddress || "",
        street: exp.street || exp.location?.street || "",
        streetNumber: exp.streetNumber || exp.location?.streetNumber || "",
        countryCode: exp.countryCode || "",
        latitude: exp.latitude ?? exp.locationLat ?? exp.location?.lat ?? null,
        longitude: exp.longitude ?? exp.locationLng ?? exp.location?.lng ?? null,
        reminderHostSent: !!exp.reminderHostSent,
        mediaCleanedAt: exp.mediaCleanedAt || null,
        host: exp.host
          ? {
              id: String(exp.host._id || exp.host),
              name: exp.host.displayName || exp.host.display_name || exp.host.name || "",
              email: exp.host.email || "",
              stripeAccountId: exp.host.stripeAccountId || null,
              isStripeChargesEnabled: !!exp.host.isStripeChargesEnabled,
              isStripePayoutsEnabled: !!exp.host.isStripePayoutsEnabled,
              isStripeDetailsSubmitted: !!exp.host.isStripeDetailsSubmitted,
            }
          : null,
      },
      counts: {
        bookingsTotal,
        bookingsActive,
        bookingsPaidLike,
        participantsBooked: Number(participantsAgg?.[0]?.participants || 0),
        reportsTotal,
        reportsOpen,
        messagesCount: Number(messagesCount?.[0]?.count || 0),
        mediaItems: media.length,
      },
      media,
      recentBookings,
      recentReports,
      recentAudit,
      timeline,
    });
  } catch (err) {
    console.error("Admin experience details error", err);
    return res.status(500).json({ message: "Failed to load experience details" });
  }
});

router.patch("/experiences/:id", requireAdminCapability(ADMIN_CAPABILITIES.EXPERIENCES_WRITE), async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !id.match(/^[a-f\d]{24}$/i)) {
      return res.status(400).json({ message: "Invalid experience id" });
    }
    const { isActive, status } = req.body || {};
    const reason = String(req.adminReason || req.body?.reason || "").trim();
    const exp = await Experience.findById(id).populate("host", "name displayName display_name email");
    if (!exp) return res.status(404).json({ message: "Experience not found" });
    const before = {
      isActive: exp.isActive !== false,
      status: exp.status || "",
      soldOut: !!exp.soldOut,
      remainingSpots: Number(exp.remainingSpots ?? 0),
    };
    const diff = {};

    if (typeof isActive === "boolean") {
      if ((exp.isActive !== false) !== isActive) {
        diff.isActive = { from: exp.isActive !== false, to: isActive };
      }
      exp.isActive = isActive;
      if (!isActive) {
        if (String(exp.status || "") !== "DISABLED") {
          diff.status = { from: exp.status || "", to: "DISABLED" };
        }
        exp.status = "DISABLED";
        exp.soldOut = true;
        exp.remainingSpots = 0;
      } else {
        if (String(exp.status).toUpperCase() === "DISABLED") {
          exp.status = "published";
        }
        const max = Number(exp.maxParticipants || 0);
        const rem = Number(exp.remainingSpots || 0);
        exp.soldOut = max > 0 ? rem <= 0 : false;
      }
    }

    if (typeof status === "string" && status.trim()) {
      const nextStatus = status.trim();
      if (!["draft", "published", "cancelled", "CANCELLED", "DISABLED", "NO_BOOKINGS"].includes(nextStatus)) {
        return res.status(400).json({ message: "Invalid experience status" });
      }
      if (String(exp.status || "") !== nextStatus) {
        diff.status = { from: exp.status || "", to: nextStatus };
      }
      exp.status = nextStatus;
    }

    const criticalExperienceAction =
      (typeof isActive === "boolean" && isActive === false) ||
      ["cancelled", "CANCELLED", "DISABLED"].includes(String(status || "").trim());
    if (criticalExperienceAction && !reason) {
      return res.status(400).json({ message: "Reason is required for disable/cancel actions" });
    }

    await exp.save();
    await writeAdminAuditLog(req, {
      actionType:
        typeof isActive === "boolean" && isActive === false
          ? "EXPERIENCE_DISABLE"
          : typeof isActive === "boolean" && isActive === true
            ? "EXPERIENCE_ENABLE"
            : "EXPERIENCE_UPDATE",
      targetType: "experience",
      targetId: String(exp._id),
      reason: reason || undefined,
      diff: Object.keys(diff).length ? diff : { before },
      meta: {
        hostId: exp.host?._id ? String(exp.host._id) : undefined,
        hostEmail: exp.host?.email || undefined,
      },
    });
    return res.json({ message: "Experience updated", experience: serializeAdminExperience(exp.toObject ? exp.toObject() : exp) });
  } catch (err) {
    console.error("Admin experience update error", err);
    return res.status(500).json({ message: "Failed to update experience" });
  }
});

router.post("/experiences/:id/delete", requireAdminCapability(ADMIN_CAPABILITIES.EXPERIENCES_WRITE), async (req, res) => {
  try {
    const { id } = req.params;
    const reason = String(req.adminReason || req.body?.reason || "").trim();
    if (!isObjectIdLike(id)) {
      return res.status(400).json({ message: "Invalid experience id" });
    }
    if (!reason) {
      return res.status(400).json({ message: "Reason is required for delete actions" });
    }

    const exp = await Experience.findById(id).populate("host", "name displayName display_name email");
    if (!exp) return res.status(404).json({ message: "Experience not found" });

    const result = await adminDeleteExperienceRecord(exp);
    await writeAdminAuditLog(req, {
      actionType: result.status === "deleted" ? "EXPERIENCE_DELETE" : "EXPERIENCE_CANCEL",
      targetType: "experience",
      targetId: String(exp._id),
      reason,
      diff:
        result.status === "deleted"
          ? {
              deleted: true,
              deletedMediaCount: Number(result.deletedMediaCount || 0),
            }
          : {
              before: result.before,
              after: result.after,
            },
      meta: {
        hostId: exp.host?._id ? String(exp.host._id) : String(exp.host || ""),
        hostEmail: exp.host?.email || undefined,
        scheduleGroupId: exp.scheduleGroupId || null,
        hadBookings: !!result.hasBookings,
      },
    });

    return res.json({
      success: true,
      message: result.status === "deleted" ? "Experience deleted" : "Experience cancelled",
      ...result,
    });
  } catch (err) {
    console.error("Admin experience delete error", err);
    return res.status(500).json({ message: "Failed to delete experience" });
  }
});

router.post("/experiences/group/:groupId/delete", requireAdminCapability(ADMIN_CAPABILITIES.EXPERIENCES_WRITE), async (req, res) => {
  try {
    const groupId = String(req.params.groupId || "").trim();
    const reason = String(req.adminReason || req.body?.reason || "").trim();
    if (!groupId) {
      return res.status(400).json({ message: "groupId is required" });
    }
    if (!reason) {
      return res.status(400).json({ message: "Reason is required for series delete actions" });
    }

    const result = await adminDeleteExperienceSeries(groupId);
    if (!result) {
      return res.status(404).json({ message: "No experiences found for this series" });
    }

    await writeAdminAuditLog(req, {
      actionType: "EXPERIENCE_SERIES_DELETE",
      targetType: "experience_group",
      targetId: groupId,
      reason,
      diff: {
        total: Number(result.total || 0),
        deletedCount: Number(result.deletedCount || 0),
        skippedWithBookings: Number(result.skippedWithBookings || 0),
        deletedMediaCount: Number(result.deletedMediaCount || 0),
      },
      meta: {
        deletedExperienceIds: result.deletedExperienceIds.slice(0, 25),
        skippedExperienceIds: result.skippedExperienceIds.slice(0, 25),
      },
    });

    return res.json({
      success: true,
      message: "Experience series processed",
      ...result,
    });
  } catch (err) {
    console.error("Admin experience series delete error", err);
    return res.status(500).json({ message: "Failed to delete experience series" });
  }
});

router.post("/experiences/group/:groupId/disable", requireAdminCapability(ADMIN_CAPABILITIES.EXPERIENCES_WRITE), async (req, res) => {
  try {
    const groupId = String(req.params.groupId || "").trim();
    const reason = String(req.adminReason || req.body?.reason || "").trim();
    if (!groupId) {
      return res.status(400).json({ message: "groupId is required" });
    }
    if (!reason) {
      return res.status(400).json({ message: "Reason is required for series disable actions" });
    }

    const result = await adminDisableExperienceSeries(groupId);
    if (!result) {
      return res.status(404).json({ message: "No experiences found for this series" });
    }

    await writeAdminAuditLog(req, {
      actionType: "EXPERIENCE_SERIES_DISABLE",
      targetType: "experience_group",
      targetId: groupId,
      reason,
      diff: {
        total: Number(result.total || 0),
        updatedCount: Number(result.updatedCount || 0),
        alreadyDisabledCount: Number(result.alreadyDisabledCount || 0),
      },
      meta: {
        updatedExperienceIds: result.updatedExperienceIds.slice(0, 25),
        alreadyDisabledIds: result.alreadyDisabledIds.slice(0, 25),
      },
    });

    return res.json({
      success: true,
      message: "Experience series disabled",
      ...result,
    });
  } catch (err) {
    console.error("Admin experience series disable error", err);
    return res.status(500).json({ message: "Failed to disable experience series" });
  }
});

router.get("/bookings", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const hostId = String(req.query.hostId || "").trim();
    const explorerId = String(req.query.explorerId || "").trim();
    const experienceId = String(req.query.experienceId || "").trim();
    const paid = parseBoolFilter(req.query.paid);
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const limit = clampLimit(req.query.limit, 20, 100);
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const skip = (page - 1) * limit;

    const filter = {};

    if (status && status !== "all") filter.status = status;
    if (isObjectIdLike(hostId)) filter.host = hostId;
    if (isObjectIdLike(explorerId)) filter.explorer = explorerId;
    if (isObjectIdLike(experienceId)) filter.experience = experienceId;

    if (typeof paid === "boolean") {
      filter.status = paid ? { $in: adminBookingPaidStatuses } : { $nin: adminBookingPaidStatuses };
      if (status && status !== "all") {
        filter.status = status;
      }
    }

    const createdAt = {};
    if (from) {
      const fromDate = new Date(from);
      if (!Number.isNaN(fromDate.getTime())) createdAt.$gte = fromDate;
    }
    if (to) {
      const toDate = new Date(to);
      if (!Number.isNaN(toDate.getTime())) createdAt.$lte = new Date(toDate.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;

    if (q) {
      const or = [];
      if (isObjectIdLike(q)) {
        or.push({ _id: q });
      }
      const safe = escapeRegex(q);
      const [userMatches, expMatches] = await Promise.all([
        User.find({
          $or: [
            { name: { $regex: safe, $options: "i" } },
            { displayName: { $regex: safe, $options: "i" } },
            { display_name: { $regex: safe, $options: "i" } },
            { email: { $regex: safe, $options: "i" } },
          ],
        })
          .select("_id")
          .limit(50)
          .lean(),
        Experience.find({
          $or: [
            { title: { $regex: safe, $options: "i" } },
            { city: { $regex: safe, $options: "i" } },
            { country: { $regex: safe, $options: "i" } },
          ],
        })
          .select("_id")
          .limit(50)
          .lean(),
      ]);
      const userIds = userMatches.map((row) => row._id);
      const expIds = expMatches.map((row) => row._id);
      if (userIds.length) {
        or.push({ explorer: { $in: userIds } });
        or.push({ host: { $in: userIds } });
      }
      if (expIds.length) {
        or.push({ experience: { $in: expIds } });
      }
      if (or.length) {
        filter.$or = or;
      } else if (!isObjectIdLike(q)) {
        return res.json({ page, limit, total: 0, pages: 1, items: [] });
      }
    }

    const [total, rows] = await Promise.all([
      Booking.countDocuments(filter),
      Booking.find(filter)
        .populate("host", "name displayName display_name email")
        .populate("explorer", "name displayName display_name email")
        .populate("experience", "title startsAt endsAt startDate endDate city country price isActive status")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const bookingIds = rows.map((row) => row._id);
    const [payments, reportsAgg, messagesAgg] = bookingIds.length
      ? await Promise.all([
          Payment.find({ booking: { $in: bookingIds } })
            .select("booking status paymentType amount totalAmount currency stripePaymentIntentId stripeSessionId")
            .sort({ createdAt: -1 })
            .lean(),
          Report.aggregate([
            { $match: { booking: { $in: bookingIds } } },
            { $group: { _id: "$booking", count: { $sum: 1 } } },
          ]),
          Message.aggregate([
            { $match: { booking: { $in: bookingIds } } },
            { $group: { _id: "$booking", count: { $sum: 1 } } },
          ]),
        ])
      : [[], [], []];

    const paymentByBooking = new Map();
    for (const p of payments) {
      const key = String(p.booking);
      if (!paymentByBooking.has(key)) {
        paymentByBooking.set(key, {
          status: p.status || "",
          paymentType: p.paymentType || "",
          amount: Number(p.totalAmount || p.amount || 0),
          currency: p.currency || "ron",
          hasStripePaymentIntent: !!p.stripePaymentIntentId,
          stripeSessionId: p.stripeSessionId || null,
        });
      }
    }
    const reportsCountByBooking = new Map(reportsAgg.map((row) => [String(row._id), Number(row.count || 0)]));
    const messagesCountByBooking = new Map(messagesAgg.map((row) => [String(row._id), Number(row.count || 0)]));

    return res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      items: rows.map((row) =>
        serializeAdminBooking(row, {
          payment: paymentByBooking.get(String(row._id)) || null,
          reportsCount: reportsCountByBooking.get(String(row._id)) || 0,
          messagesCount: messagesCountByBooking.get(String(row._id)) || 0,
        })
      ),
    });
  } catch (err) {
    console.error("Admin bookings list error", err);
    return res.status(500).json({ message: "Failed to load bookings" });
  }
});

router.get("/bookings/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectIdLike(id)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    const booking = await Booking.findById(id)
      .populate("host", "name displayName display_name email city country")
      .populate("explorer", "name displayName display_name email city country")
      .populate("experience", "title startsAt endsAt startDate endDate city country address price isActive status maxParticipants remainingSpots soldOut environment");
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const [payments, reports, messagesCount] = await Promise.all([
      Payment.find({ booking: booking._id })
        .select("status paymentType amount totalAmount currency stripePaymentIntentId stripeSessionId stripeChargeId createdAt updatedAt")
        .sort({ createdAt: -1 })
        .lean(),
      Report.find({ booking: booking._id })
        .select("type status reason comment affectsPayout createdAt handledAt actionTaken")
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Message.countDocuments({ booking: booking._id }),
    ]);

    return res.json({
      booking: serializeAdminBooking(booking.toObject ? booking.toObject() : booking, {
        payment: payments[0]
          ? {
              status: payments[0].status || "",
              paymentType: payments[0].paymentType || "",
              amount: Number(payments[0].totalAmount || payments[0].amount || 0),
              currency: payments[0].currency || "ron",
              hasStripePaymentIntent: !!payments[0].stripePaymentIntentId,
              stripeSessionId: payments[0].stripeSessionId || null,
            }
          : null,
        reportsCount: reports.length,
        messagesCount,
      }),
      payments,
      reports,
      messagesCount,
    });
  } catch (err) {
    console.error("Admin booking details error", err);
    return res.status(500).json({ message: "Failed to load booking details" });
  }
});

router.post("/bookings/:id/cancel", requireAdminCapability(ADMIN_CAPABILITIES.BOOKINGS_WRITE), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectIdLike(id)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }
    const reason = String(req.adminReason || req.body?.reason || "").trim();
    if (!reason) {
      return res.status(400).json({ message: "Reason is required" });
    }

    const booking = await Booking.findById(id)
      .populate("experience", "title maxParticipants remainingSpots soldOut isActive status")
      .populate("host", "email name displayName")
      .populate("explorer", "email name displayName");
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    if (adminBookingFinalStatuses.includes(String(booking.status || "").toUpperCase())) {
      return res.status(400).json({ message: "Booking already finalized" });
    }

    const before = {
      status: booking.status,
      cancelledAt: booking.cancelledAt || null,
      refundedAt: booking.refundedAt || null,
      payoutEligibleAt: booking.payoutEligibleAt || null,
    };

    let refundAttempted = false;
    let refundSucceeded = false;
    let refundErrorMessage = null;
    let payment = null;
    if (adminBookingPaidStatuses.includes(String(booking.status || "").toUpperCase())) {
      payment = await Payment.findOne({ booking: booking._id, status: { $in: ["CONFIRMED", "INITIATED"] } }).sort({ createdAt: -1 });
      if (payment?.stripePaymentIntentId) {
        refundAttempted = true;
        try {
          await stripe.refunds.create({
            payment_intent: payment.stripePaymentIntentId,
            refund_application_fee: true,
            reverse_transfer: true,
          });
          payment.status = "REFUNDED";
          await payment.save();
          refundSucceeded = true;
        } catch (err) {
          refundErrorMessage = err?.message || "Refund failed";
          console.error("Admin cancel booking refund error", refundErrorMessage);
        }
      }
    }

    booking.payoutEligibleAt = null;
    booking.cancelledAt = new Date();
    if (refundAttempted && !refundSucceeded) {
      booking.status = "REFUND_FAILED";
      booking.lastRefundAttemptAt = new Date();
      booking.refundAttempts = Number(booking.refundAttempts || 0) + 1;
    } else if (refundSucceeded) {
      booking.status = "REFUNDED";
      booking.refundedAt = new Date();
    } else {
      booking.status = "CANCELLED";
    }
    await booking.save();

    try {
      const currentStatus = String(before.status || "").toUpperCase();
      const reservedBefore = !["CANCELLED", "REFUNDED", "COMPLETED", "AUTO_COMPLETED", "NO_SHOW"].includes(currentStatus);
      if (reservedBefore && booking.experience && booking.status !== "REFUND_FAILED") {
        await restoreExperienceSpotsForCancelledBooking(booking, booking.experience);
      }
    } catch (err) {
      console.error("Admin cancel booking restore spots error", err);
    }

    await writeAdminAuditLog(req, {
      actionType: "BOOKING_CANCEL_ADMIN",
      targetType: "booking",
      targetId: String(booking._id),
      reason,
      diff: {
        before,
        after: {
          status: booking.status,
          cancelledAt: booking.cancelledAt || null,
          refundedAt: booking.refundedAt || null,
          payoutEligibleAt: booking.payoutEligibleAt || null,
        },
      },
      meta: {
        refundAttempted,
        refundSucceeded,
        refundErrorMessage,
        paymentId: payment?._id ? String(payment._id) : null,
      },
    });

    return res.json({
      message: refundAttempted
        ? refundSucceeded
          ? "Booking cancelled and refunded"
          : "Booking cancel recorded, refund failed"
        : "Booking cancelled",
      booking: serializeAdminBooking(booking.toObject ? booking.toObject() : booking),
      refundAttempted,
      refundSucceeded,
      refundErrorMessage,
    });
  } catch (err) {
    console.error("Admin booking cancel error", err);
    return res.status(500).json({ message: "Failed to cancel booking" });
  }
});

router.post("/bookings/:id/refund", requireAdminCapability(ADMIN_CAPABILITIES.BOOKINGS_WRITE), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectIdLike(id)) return res.status(400).json({ message: "Invalid booking id" });
    const reason = String(req.adminReason || req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ message: "Reason is required" });

    const booking = await Booking.findById(id).populate("host", "email").populate("explorer", "email");
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const payment = await Payment.findOne({ booking: booking._id, status: { $in: ["CONFIRMED", "INITIATED"] } }).sort({ createdAt: -1 });
    if (!payment?.stripePaymentIntentId) {
      return res.status(400).json({ message: "No refundable payment found" });
    }

    const before = {
      bookingStatus: booking.status,
      paymentStatus: payment.status,
      refundedAt: booking.refundedAt || null,
    };

    await stripe.refunds.create({
      payment_intent: payment.stripePaymentIntentId,
      refund_application_fee: true,
      reverse_transfer: true,
    });

    payment.status = "REFUNDED";
    await payment.save();
    booking.status = "REFUNDED";
    booking.refundedAt = new Date();
    booking.cancelledAt = booking.cancelledAt || new Date();
    booking.payoutEligibleAt = null;
    await booking.save();

    await writeAdminAuditLog(req, {
      actionType: "BOOKING_REFUND_ADMIN",
      targetType: "booking",
      targetId: String(booking._id),
      reason,
      diff: {
        before,
        after: {
          bookingStatus: booking.status,
          paymentStatus: payment.status,
          refundedAt: booking.refundedAt || null,
        },
      },
      meta: { paymentId: String(payment._id) },
    });

    return res.json({ message: "Refund succeeded", bookingId: String(booking._id), paymentId: String(payment._id) });
  } catch (err) {
    console.error("Admin booking refund error", err);
    return res.status(500).json({ message: err?.message || "Failed to refund booking" });
  }
});

router.get("/messages", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const bookingId = String(req.query.bookingId || "").trim();
    const hasReports = String(req.query.hasReports || "").trim().toLowerCase(); // true|false|all
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const limit = clampLimit(req.query.limit, 20, 100);
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const skip = (page - 1) * limit;

    let filteredBookingIds = null;
    if (bookingId && isObjectIdLike(bookingId)) {
      filteredBookingIds = [new mongoose.Types.ObjectId(bookingId)];
    }

    if (q) {
      const safe = escapeRegex(q);
      const bookingOr = [];
      if (isObjectIdLike(q)) {
        bookingOr.push({ _id: new mongoose.Types.ObjectId(q) });
      }
      const [userMatches, expMatches] = await Promise.all([
        User.find({
          $or: [
            { name: { $regex: safe, $options: "i" } },
            { displayName: { $regex: safe, $options: "i" } },
            { display_name: { $regex: safe, $options: "i" } },
            { email: { $regex: safe, $options: "i" } },
          ],
        })
          .select("_id")
          .limit(50)
          .lean(),
        Experience.find({
          $or: [
            { title: { $regex: safe, $options: "i" } },
            { city: { $regex: safe, $options: "i" } },
            { country: { $regex: safe, $options: "i" } },
          ],
        })
          .select("_id")
          .limit(50)
          .lean(),
      ]);
      const userIds = userMatches.map((row) => row._id);
      const expIds = expMatches.map((row) => row._id);
      if (userIds.length) {
        bookingOr.push({ host: { $in: userIds } }, { explorer: { $in: userIds } });
      }
      if (expIds.length) bookingOr.push({ experience: { $in: expIds } });

      const textMatchMessageBookings = await Message.find({
        message: { $regex: safe, $options: "i" },
      })
        .select("booking")
        .sort({ createdAt: -1 })
        .limit(500)
        .lean();

      const msgBookingIds = textMatchMessageBookings.map((m) => m.booking).filter(Boolean);
      if (msgBookingIds.length) {
        bookingOr.push({ _id: { $in: msgBookingIds } });
      }

      if (!bookingOr.length) {
        return res.json({ page, limit, total: 0, pages: 1, items: [] });
      }

      const bookingMatches = await Booking.find({ $or: bookingOr }).select("_id").limit(1000).lean();
      const qBookingIds = bookingMatches.map((row) => row._id);
      if (!qBookingIds.length) {
        return res.json({ page, limit, total: 0, pages: 1, items: [] });
      }
      filteredBookingIds = filteredBookingIds
        ? qBookingIds.filter((idObj) => filteredBookingIds.some((x) => String(x) === String(idObj)))
        : qBookingIds;
      if (!filteredBookingIds.length) {
        return res.json({ page, limit, total: 0, pages: 1, items: [] });
      }
    }

    const messageMatch = {};
    if (Array.isArray(filteredBookingIds)) {
      messageMatch.booking = { $in: filteredBookingIds };
    }

    const createdAt = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) createdAt.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) createdAt.$lte = new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
    if (Object.keys(createdAt).length) messageMatch.createdAt = createdAt;

    const grouped = await Message.aggregate([
      { $match: messageMatch },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$booking",
          messagesCount: { $sum: 1 },
          lastMessageAt: { $first: "$createdAt" },
          lastMessageText: { $first: "$message" },
          lastSenderId: { $first: "$sender" },
        },
      },
      { $sort: { lastMessageAt: -1 } },
    ]);

    let conversationRows = grouped;
    if (hasReports === "true" || hasReports === "false") {
      const bookingIds = grouped.map((g) => g._id);
      const reportsAgg = bookingIds.length
        ? await Report.aggregate([{ $match: { booking: { $in: bookingIds } } }, { $group: { _id: "$booking", count: { $sum: 1 } } }])
        : [];
      const reportsByBooking = new Map(reportsAgg.map((r) => [String(r._id), Number(r.count || 0)]));
      conversationRows = grouped.filter((row) => {
        const count = reportsByBooking.get(String(row._id)) || 0;
        return hasReports === "true" ? count > 0 : count === 0;
      });
    }

    const total = conversationRows.length;
    const pagedRows = conversationRows.slice(skip, skip + limit);
    const bookingIds = pagedRows.map((row) => row._id);
    const senderIds = pagedRows.map((row) => row.lastSenderId).filter(Boolean);

    const [bookings, reportsAgg, openReportsAgg, usersByIdRows] = await Promise.all([
      bookingIds.length
        ? Booking.find({ _id: { $in: bookingIds } })
            .populate("host", "name displayName display_name email")
            .populate("explorer", "name displayName display_name email")
            .populate("experience", "title startsAt endsAt startDate endDate city country price isActive status")
            .lean()
        : [],
      bookingIds.length
        ? Report.aggregate([{ $match: { booking: { $in: bookingIds } } }, { $group: { _id: "$booking", count: { $sum: 1 } } }])
        : [],
      bookingIds.length
        ? Report.aggregate([
            { $match: { booking: { $in: bookingIds }, status: { $in: ["OPEN", "INVESTIGATING"] } } },
            { $group: { _id: "$booking", count: { $sum: 1 } } },
          ])
        : [],
      senderIds.length
        ? User.find({ _id: { $in: senderIds } }).select("name displayName display_name email").lean()
        : [],
    ]);

    const bookingById = new Map(bookings.map((b) => [String(b._id), b]));
    const reportsByBooking = new Map(reportsAgg.map((r) => [String(r._id), Number(r.count || 0)]));
    const openReportsByBooking = new Map(openReportsAgg.map((r) => [String(r._id), Number(r.count || 0)]));
    const userById = new Map(usersByIdRows.map((u) => [String(u._id), u]));

    const items = pagedRows
      .map((row) => {
        const booking = bookingById.get(String(row._id));
        if (!booking) return null;
        const sender = row.lastSenderId ? userById.get(String(row.lastSenderId)) : null;
        return {
          bookingId: String(row._id),
          messagesCount: Number(row.messagesCount || 0),
          lastMessageAt: row.lastMessageAt || null,
          lastMessageText: row.lastMessageText || "",
          lastSender: sender
            ? {
                id: String(sender._id),
                name: sender.displayName || sender.display_name || sender.name || "",
                email: sender.email || "",
              }
            : null,
          reportsCount: reportsByBooking.get(String(row._id)) || 0,
          openReportsCount: openReportsByBooking.get(String(row._id)) || 0,
          booking: serializeAdminBooking(booking),
        };
      })
      .filter(Boolean);

    return res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      items,
    });
  } catch (err) {
    console.error("Admin messages list error", err);
    return res.status(500).json({ message: "Failed to load admin messages" });
  }
});

router.get("/messages/:bookingId", async (req, res) => {
  try {
    const { bookingId } = req.params;
    if (!isObjectIdLike(bookingId)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    const booking = await Booking.findById(bookingId)
      .populate("host", "name displayName display_name email city country")
      .populate("explorer", "name displayName display_name email city country")
      .populate("experience", "title startsAt endsAt startDate endDate city country address price isActive status environment");
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const [messages, reports, payments] = await Promise.all([
      Message.find({ booking: booking._id })
        .populate("sender", "name displayName display_name email")
        .sort({ createdAt: 1 })
        .limit(200)
        .lean(),
      Report.find({ booking: booking._id })
        .select("type status reason comment affectsPayout createdAt handledAt actionTaken")
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      Payment.find({ booking: booking._id })
        .select("status paymentType amount totalAmount currency stripePaymentIntentId stripeSessionId createdAt updatedAt")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);

    const summary = {
      firstMessageAt: messages[0]?.createdAt || null,
      lastMessageAt: messages[messages.length - 1]?.createdAt || null,
      messagesCount: messages.length,
      reportsOpen: reports.filter((r) => ["OPEN", "INVESTIGATING"].includes(String(r.status || ""))).length,
      reportsTotal: reports.length,
    };

    return res.json({
      booking: serializeAdminBooking(booking.toObject ? booking.toObject() : booking),
      summary,
      messages: messages.map(serializeAdminMessage),
      reports,
      payments: payments.map((p) => ({
        id: String(p._id),
        status: p.status || "",
        paymentType: p.paymentType || "",
        amount: Number(p.totalAmount || p.amount || 0),
        currency: p.currency || "ron",
        stripePaymentIntentId: p.stripePaymentIntentId || null,
        stripeSessionId: p.stripeSessionId || null,
        createdAt: p.createdAt || null,
        updatedAt: p.updatedAt || null,
      })),
    });
  } catch (err) {
    console.error("Admin message thread error", err);
    return res.status(500).json({ message: "Failed to load admin message thread" });
  }
});

router.get("/reports", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim().toUpperCase();
    const type = String(req.query.type || "").trim().toUpperCase();
    const assigned = String(req.query.assigned || "").trim().toLowerCase(); // me | unassigned | any
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const limit = clampLimit(req.query.limit, 20, 100);
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const skip = (page - 1) * limit;

    const filter = {};
    if (status && status !== "ALL") {
      if (status === "OPEN_INBOX") {
        filter.status = { $in: ["OPEN", "INVESTIGATING"] };
      } else {
        filter.status = status;
      }
    }
    if (type && type !== "ALL") filter.type = type;
    if (assigned === "me" && req.user?.email) filter.assignedTo = req.user.email;
    if (assigned === "unassigned") filter.assignedTo = { $in: [null, ""] };

    const createdAt = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) createdAt.$gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) createdAt.$lte = new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
    }
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;

    if (q) {
      const or = [];
      if (isObjectIdLike(q)) {
        or.push({ _id: q }, { booking: q }, { experience: q }, { host: q }, { reporter: q }, { targetUserId: q });
      }
      const safe = escapeRegex(q);
      or.push(
        { reason: { $regex: safe, $options: "i" } },
        { comment: { $regex: safe, $options: "i" } },
        { actionTaken: { $regex: safe, $options: "i" } }
      );
      const [userMatches, expMatches] = await Promise.all([
        User.find({
          $or: [
            { name: { $regex: safe, $options: "i" } },
            { displayName: { $regex: safe, $options: "i" } },
            { display_name: { $regex: safe, $options: "i" } },
            { email: { $regex: safe, $options: "i" } },
          ],
        })
          .select("_id")
          .limit(50)
          .lean(),
        Experience.find({
          $or: [{ title: { $regex: safe, $options: "i" } }, { city: { $regex: safe, $options: "i" } }],
        })
          .select("_id")
          .limit(50)
          .lean(),
      ]);
      const userIds = userMatches.map((r) => r._id);
      const expIds = expMatches.map((r) => r._id);
      if (userIds.length) {
        or.push({ reporter: { $in: userIds } }, { host: { $in: userIds } }, { targetUserId: { $in: userIds } });
      }
      if (expIds.length) or.push({ experience: { $in: expIds } });
      filter.$or = or;
    }

    const [total, rows] = await Promise.all([
      Report.countDocuments(filter),
      Report.find(filter)
        .populate("experience", "title status isActive city country")
        .populate("booking", "status quantity")
        .populate("host", "name displayName display_name email")
        .populate("reporter", "name displayName display_name email")
        .populate("targetUserId", "name displayName display_name email isBlocked isBanned")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const bookingIds = rows.map((r) => r.booking?._id || r.booking).filter(Boolean);
    const messagesAgg = bookingIds.length
      ? await Message.aggregate([{ $match: { booking: { $in: bookingIds } } }, { $group: { _id: "$booking", count: { $sum: 1 } } }])
      : [];
    const msgCountByBooking = new Map(messagesAgg.map((row) => [String(row._id), Number(row.count || 0)]));
    const now = new Date();

    return res.json({
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      items: rows.map((row) =>
        serializeAdminReport(row, {
          now,
          messagesCount: row.booking ? msgCountByBooking.get(String(row.booking._id || row.booking)) || 0 : 0,
        })
      ),
    });
  } catch (err) {
    console.error("Admin reports list error", err);
    return res.status(500).json({ message: "Failed to load reports" });
  }
});

router.post("/reports/:id/action", requireAdminCapability(ADMIN_CAPABILITIES.REPORTS_WRITE), async (req, res) => {
  try {
    const { id } = req.params;
    if (!isObjectIdLike(id)) return res.status(400).json({ message: "Invalid report id" });

    const action = String(req.body?.action || "").trim().toUpperCase();
    const reason = String(req.adminReason || req.body?.reason || "").trim();
    const note = String(req.body?.note || "").trim();
    const allowedActions = [
      "ASSIGN_TO_ME",
      "UNASSIGN",
      "MARK_OPEN",
      "MARK_INVESTIGATING",
      "MARK_HANDLED",
      "MARK_IGNORED",
      "PAUSE_EXPERIENCE",
      "SUSPEND_USER",
    ];
    if (!allowedActions.includes(action)) {
      return res.status(400).json({ message: "Invalid action" });
    }
    if (["PAUSE_EXPERIENCE", "SUSPEND_USER", "MARK_IGNORED"].includes(action) && !reason) {
      return res.status(400).json({ message: "Reason is required" });
    }

    const report = await Report.findById(id)
      .populate("experience", "title isActive status")
      .populate("targetUserId", "email isBlocked isBanned role")
      .populate("host", "email isBlocked isBanned")
      .populate("reporter", "email isBlocked isBanned");
    if (!report) return res.status(404).json({ message: "Report not found" });

    const before = {
      status: report.status,
      assignedTo: report.assignedTo || null,
      assignedAt: report.assignedAt || null,
      handledAt: report.handledAt || null,
      handledBy: report.handledBy || null,
      actionTaken: report.actionTaken || null,
    };

    let targetMutation = null;
    const now = new Date();

    switch (action) {
      case "ASSIGN_TO_ME":
        report.assignedTo = req.user.email;
        report.assignedAt = now;
        if (report.status === "OPEN") report.status = "INVESTIGATING";
        break;
      case "UNASSIGN":
        report.assignedTo = "";
        report.assignedAt = null;
        break;
      case "MARK_OPEN":
        report.status = "OPEN";
        report.handledAt = null;
        report.handledBy = "";
        break;
      case "MARK_INVESTIGATING":
        report.status = "INVESTIGATING";
        report.assignedTo = report.assignedTo || req.user.email;
        report.assignedAt = report.assignedAt || now;
        break;
      case "MARK_HANDLED":
        report.status = "HANDLED";
        report.handledAt = now;
        report.handledBy = req.user.email;
        break;
      case "MARK_IGNORED":
        report.status = "IGNORED";
        report.handledAt = now;
        report.handledBy = req.user.email;
        break;
      case "PAUSE_EXPERIENCE": {
        if (!report.experience?._id) return res.status(400).json({ message: "Report has no linked experience" });
        const exp = await Experience.findById(report.experience._id);
        if (!exp) return res.status(404).json({ message: "Experience not found" });
        const expBefore = { isActive: exp.isActive, status: exp.status };
        exp.isActive = false;
        if (!["CANCELLED", "cancelled"].includes(String(exp.status || ""))) {
          exp.status = "DISABLED";
        }
        await exp.save();
        report.status = "INVESTIGATING";
        report.actionTaken = "PAUSE_EXPERIENCE";
        targetMutation = {
          targetType: "experience",
          targetId: String(exp._id),
          before: expBefore,
          after: { isActive: exp.isActive, status: exp.status },
        };
        break;
      }
      case "SUSPEND_USER": {
        const userDoc =
          (report.targetUserId?._id && (await User.findById(report.targetUserId._id))) ||
          (report.host?._id && (await User.findById(report.host._id))) ||
          (report.reporter?._id && (await User.findById(report.reporter._id)));
        if (!userDoc) return res.status(400).json({ message: "No linked user to suspend" });
        if (isAdminRole(userDoc.role) && !hasOwnerWrite(req.user?.role)) {
          return res.status(403).json({ message: "Only owner admin can suspend another admin" });
        }
        const userBefore = { isBlocked: !!userDoc.isBlocked, isBanned: !!userDoc.isBanned };
        userDoc.isBlocked = true;
        await userDoc.save();
        report.status = "INVESTIGATING";
        report.actionTaken = "SUSPEND_USER";
        targetMutation = {
          targetType: "user",
          targetId: String(userDoc._id),
          before: userBefore,
          after: { isBlocked: !!userDoc.isBlocked, isBanned: !!userDoc.isBanned },
        };
        break;
      }
      default:
        break;
    }

    if (note) {
      report.actionTaken = [report.actionTaken, note].filter(Boolean).join(" | ");
    } else if (["MARK_HANDLED", "MARK_IGNORED", "MARK_INVESTIGATING", "MARK_OPEN"].includes(action)) {
      report.actionTaken = action;
    }

    await report.save();

    await writeAdminAuditLog(req, {
      actionType: `REPORT_${action}`,
      targetType: "report",
      targetId: String(report._id),
      reason: reason || undefined,
      diff: {
        before,
        after: {
          status: report.status,
          assignedTo: report.assignedTo || null,
          assignedAt: report.assignedAt || null,
          handledAt: report.handledAt || null,
          handledBy: report.handledBy || null,
          actionTaken: report.actionTaken || null,
        },
      },
      meta: targetMutation || undefined,
    });

    return res.json({
      message: "Report action applied",
      report: serializeAdminReport(report.toObject ? report.toObject() : report, { now: new Date() }),
    });
  } catch (err) {
    console.error("Admin report action error", err);
    return res.status(500).json({ message: "Failed to apply report action" });
  }
});

router.get("/payments/health", async (_req, res) => {
  try {
    const now = new Date();
    const hostRoleFilter = { role: { $in: ["HOST", "BOTH"] } };

    const [
      refundFailedCount,
      refundFailedRecentCount,
      disputedPaymentsCount,
      hostsStripeIncompleteCount,
      hostsStripeMissingAccountCount,
      eligiblePayoutBookingsCount,
      payoutAttentionCountAgg,
      refundFailedBookingsRaw,
      disputedPaymentsRaw,
      stripeIncompleteHostsRaw,
      payoutCandidateBookingsRaw,
      hostsWithStripeAccountsRaw,
      latestComplianceSnapshotsRaw,
    ] = await Promise.all([
      Booking.countDocuments({ status: "REFUND_FAILED" }),
      Booking.countDocuments({ status: "REFUND_FAILED", updatedAt: { $gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } }),
      Payment.countDocuments({ status: { $in: ["DISPUTED", "DISPUTE_LOST"] } }),
      User.countDocuments({
        ...hostRoleFilter,
        $or: [
          { stripeAccountId: { $exists: false } },
          { stripeAccountId: null },
          { stripeAccountId: "" },
          { isStripeDetailsSubmitted: { $ne: true } },
          { isStripeChargesEnabled: { $ne: true } },
          { isStripePayoutsEnabled: { $ne: true } },
        ],
      }),
      User.countDocuments({
        ...hostRoleFilter,
        $or: [{ stripeAccountId: { $exists: false } }, { stripeAccountId: null }, { stripeAccountId: "" }],
      }),
      Booking.countDocuments({
        status: { $in: ["COMPLETED", "AUTO_COMPLETED"] },
        payoutEligibleAt: { $lte: now },
      }),
      Booking.aggregate([
        {
          $match: {
            status: { $in: ["COMPLETED", "AUTO_COMPLETED"] },
            payoutEligibleAt: { $lte: now },
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "host",
            foreignField: "_id",
            as: "hostDoc",
          },
        },
        { $unwind: { path: "$hostDoc", preserveNullAndEmptyArrays: true } },
        {
          $match: {
            $or: [
              { hostDoc: null },
              { "hostDoc.stripeAccountId": { $exists: false } },
              { "hostDoc.stripeAccountId": null },
              { "hostDoc.stripeAccountId": "" },
              { "hostDoc.isStripeDetailsSubmitted": { $ne: true } },
              { "hostDoc.isStripeChargesEnabled": { $ne: true } },
              { "hostDoc.isStripePayoutsEnabled": { $ne: true } },
            ],
          },
        },
        { $count: "count" },
      ]),
      Booking.find({ status: "REFUND_FAILED" })
        .populate("host", "name displayName display_name email stripeAccountId isStripeChargesEnabled isStripePayoutsEnabled isStripeDetailsSubmitted")
        .populate("explorer", "name displayName display_name email")
        .populate("experience", "title city country startsAt startDate status isActive")
        .sort({ updatedAt: -1 })
        .limit(20)
        .lean(),
      Payment.find({ status: { $in: ["DISPUTED", "DISPUTE_LOST"] } })
        .select("booking host explorer status paymentType totalAmount amount currency stripePaymentIntentId stripeSessionId createdAt updatedAt")
        .sort({ updatedAt: -1 })
        .limit(20)
        .lean(),
      User.find({
        ...hostRoleFilter,
        $or: [
          { stripeAccountId: { $exists: false } },
          { stripeAccountId: null },
          { stripeAccountId: "" },
          { isStripeDetailsSubmitted: { $ne: true } },
          { isStripeChargesEnabled: { $ne: true } },
          { isStripePayoutsEnabled: { $ne: true } },
        ],
      })
        .select("name displayName display_name email role isBlocked isBanned stripeAccountId isStripeChargesEnabled isStripePayoutsEnabled isStripeDetailsSubmitted total_events total_participants createdAt")
        .sort({ updatedAt: -1, createdAt: -1 })
        .limit(25)
        .lean(),
      Booking.find({
        status: { $in: ["COMPLETED", "AUTO_COMPLETED"] },
        payoutEligibleAt: { $lte: now },
      })
        .populate("host", "name displayName display_name email stripeAccountId isStripeChargesEnabled isStripePayoutsEnabled isStripeDetailsSubmitted")
        .populate("explorer", "name displayName display_name email")
        .populate("experience", "title city country startsAt startDate status isActive")
        .sort({ payoutEligibleAt: 1 })
        .limit(50)
        .lean(),
      User.find({
        ...hostRoleFilter,
        stripeAccountId: { $nin: [null, ""] },
      })
        .select("name displayName display_name email role isBlocked isBanned stripeAccountId isStripeChargesEnabled isStripePayoutsEnabled isStripeDetailsSubmitted total_events total_participants createdAt")
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean(),
      HostComplianceSnapshot.aggregate([
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$user", latest: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$latest" } },
        { $sort: { createdAt: -1 } },
        { $limit: 1000 },
      ]),
    ]);

    const refundFailedBookingIds = refundFailedBookingsRaw.map((b) => b._id);
    const payoutCandidateIds = payoutCandidateBookingsRaw.map((b) => b._id);
    const disputedPaymentBookingIds = disputedPaymentsRaw.map((p) => p.booking).filter(Boolean);
    const allBookingIds = [
      ...refundFailedBookingIds,
      ...payoutCandidateIds,
      ...disputedPaymentBookingIds,
    ].filter(Boolean);

    const relatedPayments = allBookingIds.length
      ? await Payment.find({ booking: { $in: allBookingIds } })
          .select("booking status paymentType totalAmount amount currency stripePaymentIntentId stripeSessionId createdAt updatedAt")
          .sort({ updatedAt: -1, createdAt: -1 })
          .lean()
      : [];

    const paymentByBooking = new Map();
    for (const p of relatedPayments) {
      const key = String(p.booking);
      if (!paymentByBooking.has(key)) {
        paymentByBooking.set(key, {
          status: p.status || "",
          paymentType: p.paymentType || "",
          amount: Number(p.totalAmount || p.amount || 0),
          currency: p.currency || "ron",
          hasStripePaymentIntent: !!p.stripePaymentIntentId,
          stripeSessionId: p.stripeSessionId || null,
        });
      }
    }

    const disputedPaymentItems = await (async () => {
      const bookingIds = disputedPaymentsRaw.map((p) => p.booking).filter(Boolean);
      const bookings = bookingIds.length
        ? await Booking.find({ _id: { $in: bookingIds } })
            .populate("host", "name displayName display_name email stripeAccountId isStripeChargesEnabled isStripePayoutsEnabled isStripeDetailsSubmitted")
            .populate("explorer", "name displayName display_name email")
            .populate("experience", "title city country startsAt startDate status isActive")
            .lean()
        : [];
      const bookingMap = new Map(bookings.map((b) => [String(b._id), b]));

      return disputedPaymentsRaw.map((p) => {
        const b = bookingMap.get(String(p.booking));
        if (!b) {
          return {
            paymentId: String(p._id),
            bookingId: p.booking ? String(p.booking) : null,
            status: p.status || "",
            paymentType: p.paymentType || "",
            amount: Number(p.totalAmount || p.amount || 0),
            currency: p.currency || "ron",
            createdAt: p.createdAt || null,
            updatedAt: p.updatedAt || null,
            booking: null,
          };
        }
        return {
          paymentId: String(p._id),
          bookingId: String(b._id),
          status: p.status || "",
          paymentType: p.paymentType || "",
          amount: Number(p.totalAmount || p.amount || 0),
          currency: p.currency || "ron",
          createdAt: p.createdAt || null,
          updatedAt: p.updatedAt || null,
          booking: serializeAdminPaymentIssueBooking(b, {
            payment: paymentByBooking.get(String(b._id)) || null,
            issueReason: "DISPUTE",
          }),
        };
      });
    })();

    const payoutAttentionBookings = payoutCandidateBookingsRaw
      .map((b) => {
        const host = b.host || null;
        const issues = [];
        if (!host?.stripeAccountId) issues.push("HOST_NO_STRIPE_ACCOUNT");
        if (host?.stripeAccountId && !host?.isStripeDetailsSubmitted) issues.push("STRIPE_DETAILS_INCOMPLETE");
        if (host?.stripeAccountId && !host?.isStripeChargesEnabled) issues.push("STRIPE_CHARGES_DISABLED");
        if (host?.stripeAccountId && !host?.isStripePayoutsEnabled) issues.push("STRIPE_PAYOUTS_DISABLED");
        if (!issues.length) return null;
        return serializeAdminPaymentIssueBooking(b, {
          payment: paymentByBooking.get(String(b._id)) || null,
          issueReason: issues.join(","),
        });
      })
      .filter(Boolean)
      .slice(0, 20);
    const payoutAttentionCount = Number(payoutAttentionCountAgg?.[0]?.count || 0);

    const stripeOnboardingIncompleteHosts = stripeIncompleteHostsRaw.map((u) => ({
      ...serializeAdminPaymentsHost(u),
      issues: [
        !u.stripeAccountId ? "NO_ACCOUNT" : null,
        u.stripeAccountId && !u.isStripeDetailsSubmitted ? "DETAILS_INCOMPLETE" : null,
        u.stripeAccountId && !u.isStripeChargesEnabled ? "CHARGES_DISABLED" : null,
        u.stripeAccountId && !u.isStripePayoutsEnabled ? "PAYOUTS_DISABLED" : null,
      ].filter(Boolean),
    }));

    const refundFailedBookings = refundFailedBookingsRaw.map((b) =>
      serializeAdminPaymentIssueBooking(b, {
        payment: paymentByBooking.get(String(b._id)) || null,
        issueReason: "REFUND_FAILED",
      })
    );

    const complianceByUserId = new Map(
      (latestComplianceSnapshotsRaw || []).map((row) => [String(row.user || row._id || ""), row])
    );
    const hostComplianceRows = (hostsWithStripeAccountsRaw || []).map((host) =>
      serializeAdminComplianceHost(host, complianceByUserId.get(String(host._id)) || null)
    );
    const hostComplianceAttentionHosts = hostComplianceRows
      .filter((row) => (row.issues || []).length > 0)
      .sort((a, b) => {
        const aMismatch = (a.issues || []).includes("NAME_MISMATCH") ? 1 : 0;
        const bMismatch = (b.issues || []).includes("NAME_MISMATCH") ? 1 : 0;
        if (aMismatch !== bMismatch) return bMismatch - aMismatch;
        const aDue = Number(a.requirementsCurrentlyDueCount || 0);
        const bDue = Number(b.requirementsCurrentlyDueCount || 0);
        if (aDue !== bDue) return bDue - aDue;
        return new Date(b.snapshotAt || 0).getTime() - new Date(a.snapshotAt || 0).getTime();
      })
      .slice(0, 50);
    const hostComplianceAttentionCount = hostComplianceAttentionHosts.length;
    const hostComplianceNameMismatchCount = hostComplianceAttentionHosts.filter((row) =>
      (row.issues || []).includes("NAME_MISMATCH")
    ).length;
    const hostComplianceMissingBankRefCount = hostComplianceAttentionHosts.filter((row) =>
      (row.issues || []).includes("BANK_REFERENCE_MISSING")
    ).length;
    const hostComplianceNoSnapshotCount = hostComplianceAttentionHosts.filter((row) =>
      (row.issues || []).includes("NO_COMPLIANCE_SNAPSHOT")
    ).length;

    return res.json({
      generatedAt: now.toISOString(),
      summary: {
        refundFailedBookings: refundFailedCount,
        refundFailedLast7d: refundFailedRecentCount,
        disputedPayments: disputedPaymentsCount,
        stripeOnboardingIncompleteHosts: hostsStripeIncompleteCount,
        stripeMissingAccountHosts: hostsStripeMissingAccountCount,
        payoutEligibleBookings: eligiblePayoutBookingsCount,
        payoutAttentionBookings: payoutAttentionCount,
        hostComplianceAttentionHosts: hostComplianceAttentionCount,
        hostComplianceNameMismatches: hostComplianceNameMismatchCount,
        hostComplianceMissingBankReference: hostComplianceMissingBankRefCount,
        hostComplianceNoSnapshot: hostComplianceNoSnapshotCount,
      },
      refundFailedBookings,
      stripeOnboardingIncompleteHosts,
      payoutAttentionBookings,
      disputedPayments: disputedPaymentItems,
      hostComplianceAttentionHosts,
    });
  } catch (err) {
    console.error("Admin payments health error", err);
    return res.status(500).json({ message: "Failed to load payments health" });
  }
});

router.get("/system/health", requireOwnerAdmin, async (_req, res) => {
  try {
    const now = new Date();
    const readyStateMap = {
      0: "disconnected",
      1: "connected",
      2: "connecting",
      3: "disconnecting",
    };

    const adminAllowlist = String(process.env.ADMIN_ALLOWED_EMAILS || "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);

    const [openReports, investigatingReports, refundFailedBookings, disputedPayments, staleInitiatedPayments, recentAuditActions] =
      await Promise.all([
        Report.countDocuments({ status: "OPEN" }),
        Report.countDocuments({ status: "INVESTIGATING" }),
        Booking.countDocuments({ status: "REFUND_FAILED" }),
        Payment.countDocuments({ status: { $in: ["DISPUTED", "DISPUTE_LOST"] } }),
        Payment.countDocuments({
          status: "INITIATED",
          createdAt: { $lte: new Date(now.getTime() - 30 * 60 * 1000) },
        }),
        AdminAuditLog.countDocuments({
          createdAt: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
        }),
      ]);

    const webOrigins = String(process.env.ALLOWED_WEB_ORIGINS || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    return res.json({
      generatedAt: now.toISOString(),
      runtime: {
        nodeVersion: process.version,
        env: process.env.NODE_ENV || "development",
        uptimeSeconds: Math.floor(process.uptime()),
        pid: process.pid,
      },
      database: {
        state: readyStateMap[mongoose.connection.readyState] || "unknown",
        name: mongoose.connection.name || null,
        host: mongoose.connection.host || null,
      },
      security: {
        adminAllowlistConfigured: adminAllowlist.length > 0,
        adminAllowlistCount: adminAllowlist.length,
        adminRateLimitWindowMs: ADMIN_RATE_LIMIT_WINDOW_MS,
        adminRateLimitMax: ADMIN_RATE_LIMIT_MAX,
        jwtSecretConfigured: !!process.env.JWT_SECRET,
        adminActionSecretConfigured: !!process.env.ADMIN_ACTION_SECRET,
        cookieSecretConfigured: !!process.env.COOKIE_SECRET,
      },
      integrations: {
        stripeSecretConfigured: !!process.env.STRIPE_SECRET_KEY,
        stripeWebhookSecretConfigured: !!process.env.STRIPE_WEBHOOK_SECRET,
        cloudinaryConfigured:
          !!process.env.CLOUDINARY_CLOUD_NAME &&
          !!process.env.CLOUDINARY_API_KEY &&
          !!process.env.CLOUDINARY_API_SECRET,
        resendConfigured: !!process.env.RESEND_API_KEY,
        smtpConfigured:
          !!process.env.SMTP_HOST &&
          !!process.env.SMTP_USER &&
          !!process.env.SMTP_PASS,
        reportsEmailConfigured: !!process.env.REPORTS_EMAIL,
      },
      web: {
        allowedWebOriginsCount: webOrigins.length,
        allowedWebOrigins: webOrigins.slice(0, 20),
      },
      opsAttention: {
        openReports,
        investigatingReports,
        refundFailedBookings,
        disputedPayments,
        staleInitiatedPayments,
        adminActionsLast24h: recentAuditActions,
      },
    });
  } catch (err) {
    console.error("Admin system health error", err);
    return res.status(500).json({ message: "Failed to load system health" });
  }
});

router.get("/media/stats", async (_req, res) => {
  try {
    const now = new Date();
    const retentionHours = Number(process.env.MEDIA_RETENTION_HOURS || 72);
    const cutoff = new Date(now.getTime() - retentionHours * 60 * 60 * 1000);
    const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const experiences = await Experience.find({
      $or: [
        { "mediaRefs.0": { $exists: true } },
        { "images.0": { $exists: true } },
        { "videos.0": { $exists: true } },
        { mainImageUrl: { $exists: true, $nin: ["", null] } },
        { coverImageUrl: { $exists: true, $nin: ["", null] } },
      ],
    })
      .select("isActive status endsAt endDate startsAt startDate durationMinutes updatedAt mediaRefs images videos mainImageUrl coverImageUrl mediaCleanedAt")
      .lean();

    const withMedia = experiences.filter((exp) => hasExperienceMedia(exp));
    const activeWithMedia = withMedia.filter((exp) => exp.isActive !== false);
    const inactiveWithMedia = withMedia.filter((exp) => exp.isActive === false);
    const cleanedWithMedia = withMedia.filter((exp) => !!exp.mediaCleanedAt);
    const pendingCleanup = withMedia.filter((exp) => !exp.mediaCleanedAt);

    const cleanupCandidates = pendingCleanup.filter((exp) => {
      const eligibleAt = getCleanupEligibleAt(exp);
      return !!eligibleAt && eligibleAt <= cutoff;
    });

    let activeBookingSet = new Set();
    if (cleanupCandidates.length) {
      const candidateIds = cleanupCandidates.map((exp) => exp._id);
      const activeBookingRows = await Booking.aggregate([
        {
          $match: {
            experience: { $in: candidateIds },
            status: { $in: cleanupActiveStatuses },
          },
        },
        { $group: { _id: "$experience" } },
      ]);
      activeBookingSet = new Set(activeBookingRows.map((row) => String(row._id)));
    }

    const orphanCandidates = cleanupCandidates.filter((exp) => !activeBookingSet.has(String(exp._id)));
    const blockedByActiveBookings = cleanupCandidates.length - orphanCandidates.length;

    const usersWithAvatar = await User.countDocuments({
      $or: [
        { avatarPublicId: { $exists: true, $nin: ["", null] } },
        { avatar: { $exists: true, $nin: ["", null] } },
      ],
    });

    const [deleted24hRows, deleted24hByScope] = await Promise.all([
      MediaDeletionLog.aggregate([
        { $match: { createdAt: { $gte: since24h } } },
        {
          $group: {
            _id: null,
            events: { $sum: 1 },
            requestedCount: { $sum: "$requestedCount" },
            deletedCount: { $sum: "$deletedCount" },
          },
        },
      ]),
      MediaDeletionLog.aggregate([
        { $match: { createdAt: { $gte: since24h } } },
        {
          $group: {
            _id: "$scope",
            events: { $sum: 1 },
            deletedCount: { $sum: "$deletedCount" },
          },
        },
        { $sort: { deletedCount: -1, events: -1 } },
      ]),
    ]);

    const deleted24h = deleted24hRows[0] || {
      events: 0,
      requestedCount: 0,
      deletedCount: 0,
    };

    return res.json({
      generatedAt: now.toISOString(),
      retentionHours,
      cutoff: cutoff.toISOString(),
      summary: {
        experiencesWithMedia: withMedia.length,
        activeExperiencesWithMedia: activeWithMedia.length,
        inactiveExperiencesWithMedia: inactiveWithMedia.length,
        cleanedExperiencesWithMedia: cleanedWithMedia.length,
        pendingCleanupExperiences: pendingCleanup.length,
        cleanupCandidates: cleanupCandidates.length,
        orphanCandidates: orphanCandidates.length,
        blockedByActiveBookings,
        usersWithAvatar,
      },
      deletedLast24h: {
        events: deleted24h.events || 0,
        requestedCount: deleted24h.requestedCount || 0,
        deletedCount: deleted24h.deletedCount || 0,
      },
      deletedLast24hByScope: deleted24hByScope.map((row) => ({
        scope: row._id || "unknown",
        events: row.events || 0,
        deletedCount: row.deletedCount || 0,
      })),
      orphanCandidateSample: orphanCandidates.slice(0, 20).map((exp) => ({
        id: String(exp._id),
        status: exp.status,
        isActive: exp.isActive,
        eligibleAt: getCleanupEligibleAt(exp)?.toISOString?.() || null,
        updatedAt: exp.updatedAt?.toISOString?.() || null,
      })),
    });
  } catch (err) {
    console.error("Admin media stats error", err);
    return res.status(500).json({ message: "Failed to build media stats" });
  }
});

// simple preview page for reports (token-protected)
router.get("/report/:id/preview", async (req, res) => {
  try {
    const { token } = req.query;
    const { id } = req.params;
    if (!token) return res.status(401).send("Missing token");
    try {
      verifyToken(token);
    } catch (err) {
      return res.status(401).send("Invalid or expired token");
    }
    const report = await Report.findById(id).populate("experience").populate("host").populate("reporter");
    if (!report) return res.status(404).send("Report not found");
    const exp = report.experience || {};
    const host = report.host || {};
    const reporter = report.reporter || {};
    const actionsHtml = `
      <p><strong>Actions:</strong></p>
      <ul>
        <li><a href="${req.protocol}://${req.get("host")}/admin/report-action?action=DISABLE_EXPERIENCE&experienceId=${exp._id}&reportId=${report._id}&token=${encodeURIComponent(token)}">Disable Experience</a></li>
        <li><a href="${req.protocol}://${req.get("host")}/admin/report-action?action=BAN_HOST&hostId=${host._id}&reportId=${report._id}&token=${encodeURIComponent(token)}">Ban Host</a></li>
        ${reporter?._id ? `<li><a href="${req.protocol}://${req.get("host")}/admin/report-action?action=BAN_EXPLORER&explorerId=${reporter._id}&reportId=${report._id}&token=${encodeURIComponent(token)}">Ban Explorer</a></li>` : ""}
        <li><a href="${req.protocol}://${req.get("host")}/admin/report-action?action=IGNORE_REPORT&reportId=${report._id}&token=${encodeURIComponent(token)}">Ignore</a></li>
      </ul>
    `;
    const html = `
      <h2>Report preview (${report.type})</h2>
      <p><strong>Status:</strong> ${report.status}</p>
      <h3>Experience</h3>
      <p>${exp.title || ""} (${exp._id || ""})</p>
      <p>${exp.address || ""}</p>
      <p>Status: ${exp.isActive === false ? "DISABLED" : "ACTIVE"}</p>
      ${exp.description ? `<p><strong>About the experience:</strong><br/>${exp.description}</p>` : ""}
      ${exp.images?.length ? `<p>Images:</p>${exp.images.map((i) => `<img src="${i}" width="120" />`).join("")}` : ""}
      <h3>Host</h3>
      <p>${host.name || host.displayName || ""} (${host._id || ""})</p>
      <p>Email: ${host.email || ""}</p>
      <p>Phone: ${host.phone || host.phoneNumber || ""}</p>
      <h3>Reporter</h3>
      <p>${reporter.name || reporter.displayName || reporter._id || "anonymous"}</p>
      <p>Email: ${reporter.email || ""}</p>
      <p>Phone: ${reporter.phone || reporter.phoneNumber || ""}</p>
      <h3>Details</h3>
      <p>Reason: ${report.reason || ""}</p>
      <p>Comment: ${report.comment || ""}</p>
      ${actionsHtml}
    `;
    res.send(html);
  } catch (err) {
    console.error("Report preview error", err);
    res.status(500).send("Server error");
  }
});

module.exports = router;
