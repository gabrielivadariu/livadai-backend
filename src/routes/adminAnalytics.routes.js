const { Router } = require("express");
const mongoose = require("mongoose");
const Booking = require("../models/booking.model");
const Experience = require("../models/experience.model");
const Payment = require("../models/payment.model");
const User = require("../models/user.model");
const AnalyticsEvent = require("../models/analyticsEvent.model");
const { authenticate, requireAdminAllowlist, requireAdminCapability } = require("../middleware/auth.middleware");
const { ADMIN_CAPABILITIES } = require("../utils/adminRoles");

const router = Router();

const PAGE_VIEW_EVENTS = ["page_view", "screen_view"];
const COMPLETED_BOOKING_STATUSES = ["COMPLETED", "AUTO_COMPLETED"];
const CANCELLED_BOOKING_STATUSES = ["CANCELLED", "REFUNDED", "REFUND_FAILED"];
const PAID_BOOKING_STATUSES = ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE", "DISPUTED", "DISPUTE_WON", "DISPUTE_LOST"];
const TOP_LIMIT = 15;

router.use(authenticate, requireAdminAllowlist, requireAdminCapability(ADMIN_CAPABILITIES.PANEL_READ));

const startOfDay = (date) => {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const clampTop = (value, fallback = TOP_LIMIT, max = 50) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
};

const buildRange = (query = {}) => {
  const now = new Date();
  const todayStart = startOfDay(now);
  const tomorrowStart = addDays(todayStart, 1);
  const yesterdayStart = addDays(todayStart, -1);
  const yesterdayEnd = todayStart;

  const rangeKey = String(query.range || "last7d").trim().toLowerCase();

  if (rangeKey === "today") {
    return { key: "today", label: "Today", start: todayStart, end: tomorrowStart };
  }
  if (rangeKey === "yesterday") {
    return { key: "yesterday", label: "Yesterday", start: yesterdayStart, end: yesterdayEnd };
  }
  if (rangeKey === "last30d") {
    return { key: "last30d", label: "Last 30 days", start: addDays(todayStart, -29), end: tomorrowStart };
  }
  if (rangeKey === "custom") {
    const from = query.from ? new Date(`${query.from}T00:00:00`) : null;
    const to = query.to ? new Date(`${query.to}T23:59:59.999`) : null;
    if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to) {
      return { key: "custom", label: "Custom range", start: from, end: new Date(to.getTime() + 1) };
    }
  }
  return { key: "last7d", label: "Last 7 days", start: addDays(todayStart, -6), end: tomorrowStart };
};

const buildTimeMatch = (field, range) => ({
  [field]: {
    $gte: range.start,
    $lt: range.end,
  },
});

const exprHasValue = (field) => ({
  $and: [{ $ne: [field, null] }, { $ne: [field, ""] }],
});

const nonEmptyExpr = (field, fallback) => ({
  $cond: [exprHasValue(field), field, fallback],
});

const visitorKeyExpr = nonEmptyExpr(
  "$visitorKey",
  nonEmptyExpr(
    "$anonymousId",
    {
      $cond: [
        { $ne: ["$userId", null] },
        { $concat: ["user:", { $toString: "$userId" }] },
        nonEmptyExpr("$sessionId", ""),
      ],
    }
  )
);

const sessionKeyExpr = nonEmptyExpr("$sessionId", visitorKeyExpr);

const toRate = (value, total) => {
  if (!total) return 0;
  return Number(((value / total) * 100).toFixed(2));
};

const toCountMap = (rows, fieldName = "count") =>
  (rows || []).reduce((acc, row) => {
    const key = row?._id?.toString?.() || String(row?._id || "");
    if (!key) return acc;
    acc.set(key, Number(row[fieldName] || 0));
    return acc;
  }, new Map());

const toValueMap = (rows, buildValue) =>
  (rows || []).reduce((acc, row) => {
    const key = row?._id?.toString?.() || String(row?._id || "");
    if (!key) return acc;
    acc.set(key, buildValue(row));
    return acc;
  }, new Map());

const getDistinctCount = async (match, expr) => {
  const rows = await AnalyticsEvent.aggregate([
    { $match: match },
    { $project: { key: expr } },
    { $match: { key: { $ne: "" } } },
    { $group: { _id: "$key" } },
    { $count: "count" },
  ]);
  return Number(rows[0]?.count || 0);
};

const getSessionMetrics = async (range) => {
  const rows = await AnalyticsEvent.aggregate([
    { $match: buildTimeMatch("timestamp", range) },
    {
      $project: {
        sessionKey: sessionKeyExpr,
        timestamp: 1,
        eventName: 1,
        durationMs: { $ifNull: ["$durationMs", 0] },
      },
    },
    { $match: { sessionKey: { $ne: "" } } },
    {
      $group: {
        _id: "$sessionKey",
        startedAt: { $min: "$timestamp" },
        endedAt: { $max: "$timestamp" },
        pageViews: {
          $sum: {
            $cond: [{ $in: ["$eventName", PAGE_VIEW_EVENTS] }, 1, 0],
          },
        },
        exits: {
          $sum: {
            $cond: [{ $eq: ["$eventName", "page_exit"] }, 1, 0],
          },
        },
        explicitDurationMs: {
          $sum: {
            $cond: [
              {
                $and: [{ $eq: ["$eventName", "page_exit"] }, { $gt: ["$durationMs", 0] }],
              },
              "$durationMs",
              0,
            ],
          },
        },
      },
    },
  ]);

  const totalSessions = rows.length;
  const totals = rows.reduce(
    (acc, row) => {
      const fallbackDuration = Math.max(
        0,
        new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime()
      );
      const durationMs = Number(row.explicitDurationMs || 0) > 0 ? Number(row.explicitDurationMs || 0) : fallbackDuration;
      acc.durationMs += durationMs;
      acc.pageViews += Number(row.pageViews || 0);
      acc.exits += Number(row.exits || 0);
      if (Number(row.pageViews || 0) <= 1) acc.bounces += 1;
      return acc;
    },
    { durationMs: 0, pageViews: 0, exits: 0, bounces: 0 }
  );

  return {
    totalSessions,
    pageViews: totals.pageViews,
    averageSessionDurationMs: totalSessions ? Math.round(totals.durationMs / totalSessions) : 0,
    bounceRate: toRate(totals.bounces, totalSessions),
    exitRate: toRate(totals.exits, totals.pageViews),
  };
};

const getNewVsReturning = async (range) => {
  const rows = await AnalyticsEvent.aggregate([
    { $match: { timestamp: { $lt: range.end } } },
    {
      $project: {
        visitorKey: visitorKeyExpr,
        timestamp: 1,
      },
    },
    { $match: { visitorKey: { $ne: "" } } },
    {
      $group: {
        _id: "$visitorKey",
        firstSeen: { $min: "$timestamp" },
        seenInRange: {
          $max: {
            $cond: [
              {
                $and: [{ $gte: ["$timestamp", range.start] }, { $lt: ["$timestamp", range.end] }],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $match: { seenInRange: 1 } },
  ]);

  return rows.reduce(
    (acc, row) => {
      if (new Date(row.firstSeen).getTime() >= range.start.getTime()) acc.newUsers += 1;
      else acc.returningUsers += 1;
      return acc;
    },
    { newUsers: 0, returningUsers: 0 }
  );
};

const getTopTrafficRows = async ({ range, groupId, projectId, sortField = "count", limit = TOP_LIMIT, extraMatch = {} }) => {
  return AnalyticsEvent.aggregate([
    {
      $match: {
        ...buildTimeMatch("timestamp", range),
        eventName: { $in: PAGE_VIEW_EVENTS },
        ...extraMatch,
      },
    },
    { $project: projectId },
    { $group: groupId },
    { $sort: { [sortField]: -1 } },
    { $limit: limit },
  ]);
};

const getSearchInsights = async (range, limit) => {
  const [topKeywords, noResults, topFilters, topLocations, topCategories] = await Promise.all([
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: "search_initiated",
          searchQueryNormalized: { $ne: "" },
        },
      },
      {
        $group: {
          _id: "$searchQueryNormalized",
          keyword: { $first: "$searchQuery" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          $or: [
            { eventName: "search_no_results" },
            { eventName: "search_results_viewed", searchResultsCount: 0 },
          ],
          searchQueryNormalized: { $ne: "" },
        },
      },
      {
        $group: {
          _id: "$searchQueryNormalized",
          keyword: { $first: "$searchQuery" },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: { $in: ["search_initiated", "search_results_viewed"] },
          "searchFilters.0": { $exists: true },
        },
      },
      { $unwind: "$searchFilters" },
      { $group: { _id: "$searchFilters", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: "search_initiated",
          searchLocation: { $ne: "" },
        },
      },
      { $group: { _id: "$searchLocation", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: "search_initiated",
          searchCategory: { $ne: "" },
        },
      },
      { $group: { _id: "$searchCategory", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]),
  ]);

  return {
    topKeywords: topKeywords.map((row) => ({ keyword: row.keyword || row._id, count: Number(row.count || 0) })),
    noResults: noResults.map((row) => ({ keyword: row.keyword || row._id, count: Number(row.count || 0) })),
    topFilters: topFilters.map((row) => ({ filter: row._id || "", count: Number(row.count || 0) })),
    topLocations: topLocations.map((row) => ({ location: row._id || "", count: Number(row.count || 0) })),
    topCategories: topCategories.map((row) => ({ category: row._id || "", count: Number(row.count || 0) })),
  };
};

const getSessionFunnelRows = async (range) =>
  AnalyticsEvent.aggregate([
    { $match: buildTimeMatch("timestamp", range) },
    {
      $project: {
        sessionKey: sessionKeyExpr,
        eventName: 1,
      },
    },
    { $match: { sessionKey: { $ne: "" } } },
    {
      $group: {
        _id: "$sessionKey",
        homepageVisit: {
          $max: {
            $cond: [{ $eq: ["$eventName", "homepage_visit"] }, 1, 0],
          },
        },
        searchInitiated: {
          $max: {
            $cond: [{ $eq: ["$eventName", "search_initiated"] }, 1, 0],
          },
        },
        searchResultsViewed: {
          $max: {
            $cond: [{ $eq: ["$eventName", "search_results_viewed"] }, 1, 0],
          },
        },
        experienceViewed: {
          $max: {
            $cond: [
              { $in: ["$eventName", ["experience_viewed", "experience_result_clicked"]] },
              1,
              0,
            ],
          },
        },
        bookingStarted: {
          $max: {
            $cond: [{ $eq: ["$eventName", "booking_started"] }, 1, 0],
          },
        },
        checkoutStarted: {
          $max: {
            $cond: [{ $eq: ["$eventName", "checkout_started"] }, 1, 0],
          },
        },
        paymentCompleted: {
          $max: {
            $cond: [{ $eq: ["$eventName", "payment_completed"] }, 1, 0],
          },
        },
        bookingConfirmed: {
          $max: {
            $cond: [{ $eq: ["$eventName", "booking_confirmed"] }, 1, 0],
          },
        },
      },
    },
  ]);

const buildFunnel = (rows) => {
  const steps = [
    { key: "homepageVisit", label: "Homepage visit" },
    { key: "searchInitiated", label: "Search initiated" },
    { key: "searchResultsViewed", label: "Search results viewed" },
    { key: "experienceViewed", label: "Experience page viewed" },
    { key: "bookingStarted", label: "Booking started" },
    { key: "checkoutStarted", label: "Checkout started" },
    { key: "paymentCompleted", label: "Payment completed" },
    { key: "bookingConfirmed", label: "Booking confirmed" },
  ];

  let previousCount = 0;
  return steps.map((step, index) => {
    const count = rows.reduce((sum, row) => sum + Number(row[step.key] || 0), 0);
    const conversionRate = index === 0 ? 100 : toRate(count, previousCount);
    const dropOff = index === 0 ? 0 : Math.max(previousCount - count, 0);
    previousCount = count;
    return {
      key: step.key,
      label: step.label,
      sessions: count,
      conversionRate,
      dropOff,
    };
  });
};

const getExperiencePerformance = async (range, limit) => {
  const [viewRows, clickRows, shareRows, favoriteRows, impressionRows, bookingRows, completionRows, cancellationRows, revenueRows] =
    await Promise.all([
      AnalyticsEvent.aggregate([
        { $match: { ...buildTimeMatch("timestamp", range), eventName: "experience_viewed", experienceId: { $ne: null } } },
        { $group: { _id: "$experienceId", count: { $sum: 1 } } },
      ]),
      AnalyticsEvent.aggregate([
        {
          $match: {
            ...buildTimeMatch("timestamp", range),
            eventName: "experience_result_clicked",
            experienceId: { $ne: null },
          },
        },
        { $group: { _id: "$experienceId", count: { $sum: 1 } } },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { ...buildTimeMatch("timestamp", range), eventName: "experience_shared", experienceId: { $ne: null } } },
        { $group: { _id: "$experienceId", count: { $sum: 1 } } },
      ]),
      AnalyticsEvent.aggregate([
        { $match: { ...buildTimeMatch("timestamp", range), eventName: "experience_favorited", experienceId: { $ne: null } } },
        { $group: { _id: "$experienceId", count: { $sum: 1 } } },
      ]),
      AnalyticsEvent.aggregate([
        {
          $match: {
            ...buildTimeMatch("timestamp", range),
            eventName: "search_results_viewed",
            "resultIds.0": { $exists: true },
          },
        },
        { $unwind: "$resultIds" },
        { $group: { _id: "$resultIds", count: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        { $match: buildTimeMatch("createdAt", range) },
        { $group: { _id: "$experience", bookings: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        { $match: { ...buildTimeMatch("completedAt", range), status: { $in: COMPLETED_BOOKING_STATUSES } } },
        { $group: { _id: "$experience", completed: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        {
          $match: {
            status: { $in: CANCELLED_BOOKING_STATUSES },
            $or: [buildTimeMatch("cancelledAt", range), buildTimeMatch("refundedAt", range), buildTimeMatch("updatedAt", range)],
          },
        },
        { $group: { _id: "$experience", cancelled: { $sum: 1 } } },
      ]),
      Payment.aggregate([
        { $match: { ...buildTimeMatch("updatedAt", range), status: "CONFIRMED" } },
        {
          $lookup: {
            from: "bookings",
            localField: "booking",
            foreignField: "_id",
            as: "booking",
          },
        },
        { $unwind: "$booking" },
        {
          $group: {
            _id: "$booking.experience",
            revenueMinor: { $sum: { $ifNull: ["$totalAmount", "$amount"] } },
            platformFeeMinor: { $sum: { $ifNull: ["$platformFee", 0] } },
            paidBookingIds: { $addToSet: "$booking._id" },
          },
        },
      ]),
    ]);

  const viewMap = toCountMap(viewRows);
  const clickMap = toCountMap(clickRows);
  const shareMap = toCountMap(shareRows);
  const favoriteMap = toCountMap(favoriteRows);
  const bookingMap = toValueMap(bookingRows, (row) => Number(row.bookings || 0));
  const completionMap = toValueMap(completionRows, (row) => Number(row.completed || 0));
  const cancellationMap = toValueMap(cancellationRows, (row) => Number(row.cancelled || 0));
  const impressionMap = toCountMap(impressionRows);
  const revenueMap = toValueMap(revenueRows, (row) => ({
    revenueMinor: Number(row.revenueMinor || 0),
    platformFeeMinor: Number(row.platformFeeMinor || 0),
    paidBookings: Array.isArray(row.paidBookingIds) ? row.paidBookingIds.length : 0,
  }));

  const experienceIds = new Set([
    ...viewMap.keys(),
    ...clickMap.keys(),
    ...shareMap.keys(),
    ...favoriteMap.keys(),
    ...bookingMap.keys(),
    ...completionMap.keys(),
    ...cancellationMap.keys(),
    ...revenueMap.keys(),
    ...impressionMap.keys(),
  ]);

  const objectIds = Array.from(experienceIds).filter((id) => mongoose.Types.ObjectId.isValid(id));
  const experiences = await Experience.find({ _id: { $in: objectIds } }).populate("host", "name displayName display_name email");
  const experienceMap = new Map(experiences.map((exp) => [String(exp._id), exp]));

  const rows = Array.from(experienceIds)
    .map((id) => {
      const exp = experienceMap.get(id);
      const views = Number(viewMap.get(id) || 0);
      const impressions = Number(impressionMap.get(id) || 0);
      const clicks = Number(clickMap.get(id) || 0);
      const bookings = Number(bookingMap.get(id) || 0);
      const completed = Number(completionMap.get(id) || 0);
      const cancelled = Number(cancellationMap.get(id) || 0);
      const shares = Number(shareMap.get(id) || 0);
      const favorites = Number(favoriteMap.get(id) || 0);
      const revenue = revenueMap.get(id) || { revenueMinor: 0, platformFeeMinor: 0, paidBookings: 0 };
      return {
        experienceId: id,
        title: exp?.title || "Unknown experience",
        hostId: exp?.host?._id?.toString?.() || exp?.host?.toString?.() || "",
        hostName:
          exp?.host?.displayName || exp?.host?.display_name || exp?.host?.name || exp?.hostProfile?.displayName || "Unknown host",
        city: exp?.city || exp?.location?.city || "",
        country: exp?.country || exp?.location?.country || "",
        views,
        impressions,
        clickThroughRate: toRate(clicks, impressions),
        bookings,
        paidBookings: Number(revenue.paidBookings || 0),
        conversionRate: toRate(bookings, views),
        revenueMinor: Number(revenue.revenueMinor || 0),
        platformFeeMinor: Number(revenue.platformFeeMinor || 0),
        completionRate: toRate(completed, bookings),
        cancellationRate: toRate(cancelled, bookings),
        favoriteRate: toRate(favorites, views),
        shareRate: toRate(shares, views),
      };
    })
    .filter((row) => row.views || row.bookings || row.revenueMinor || row.impressions)
    .sort((a, b) => {
      if (b.revenueMinor !== a.revenueMinor) return b.revenueMinor - a.revenueMinor;
      if (b.bookings !== a.bookings) return b.bookings - a.bookings;
      return b.views - a.views;
    });

  return rows.slice(0, limit);
};

const getHostPerformance = async (experienceRows, limit) => {
  const hostExperienceTotals = await Experience.aggregate([
    {
      $group: {
        _id: "$host",
        totalExperiences: { $sum: 1 },
      },
    },
  ]);
  const totalExperienceMap = toValueMap(hostExperienceTotals, (row) => Number(row.totalExperiences || 0));

  const hostMap = new Map();
  for (const row of experienceRows) {
    if (!row.hostId) continue;
    const existing = hostMap.get(row.hostId) || {
      hostId: row.hostId,
      hostName: row.hostName || "Unknown host",
      totalExperiences: Number(totalExperienceMap.get(row.hostId) || 0),
      totalViews: 0,
      totalBookings: 0,
      revenueMinor: 0,
      cancellationRateNumerator: 0,
      topPerformingExperiences: [],
    };

    existing.totalViews += Number(row.views || 0);
    existing.totalBookings += Number(row.bookings || 0);
    existing.revenueMinor += Number(row.revenueMinor || 0);
    existing.cancellationRateNumerator += Number(row.bookings || 0) * (Number(row.cancellationRate || 0) / 100);
    existing.topPerformingExperiences.push({
      experienceId: row.experienceId,
      title: row.title,
      revenueMinor: row.revenueMinor,
      bookings: row.bookings,
    });

    hostMap.set(row.hostId, existing);
  }

  return Array.from(hostMap.values())
    .map((row) => ({
      hostId: row.hostId,
      hostName: row.hostName,
      totalExperiences: row.totalExperiences,
      totalViews: row.totalViews,
      totalBookings: row.totalBookings,
      conversionRate: toRate(row.totalBookings, row.totalViews),
      revenueMinor: row.revenueMinor,
      responseRate: null,
      cancellationRate: toRate(row.cancellationRateNumerator, row.totalBookings),
      topPerformingExperiences: row.topPerformingExperiences
        .sort((a, b) => {
          if (b.revenueMinor !== a.revenueMinor) return b.revenueMinor - a.revenueMinor;
          return b.bookings - a.bookings;
        })
        .slice(0, 3),
    }))
    .sort((a, b) => {
      if (b.revenueMinor !== a.revenueMinor) return b.revenueMinor - a.revenueMinor;
      if (b.totalBookings !== a.totalBookings) return b.totalBookings - a.totalBookings;
      return b.totalViews - a.totalViews;
    })
    .slice(0, limit);
};

const getBehaviorInsights = async (range, limit) => {
  const [topPages, exitPoints, ctaClicks, navigationPaths, scrollDepth, timeOnPage] = await Promise.all([
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: { $in: PAGE_VIEW_EVENTS },
          path: { $ne: "" },
        },
      },
      { $group: { _id: "$path", views: { $sum: 1 } } },
      { $sort: { views: -1 } },
      { $limit: limit },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: "page_exit",
          path: { $ne: "" },
        },
      },
      { $group: { _id: "$path", exits: { $sum: 1 } } },
      { $sort: { exits: -1 } },
      { $limit: limit },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: "cta_clicked",
          ctaName: { $ne: "" },
        },
      },
      { $group: { _id: "$ctaName", clicks: { $sum: 1 } } },
      { $sort: { clicks: -1 } },
      { $limit: limit },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: "navigation_transition",
          "properties.fromPath": { $exists: true },
          "properties.toPath": { $exists: true },
        },
      },
      {
        $group: {
          _id: {
            fromPath: "$properties.fromPath",
            toPath: "$properties.toPath",
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: "scroll_depth",
          path: { $ne: "" },
        },
      },
      {
        $group: {
          _id: "$path",
          averageDepth: { $avg: "$scrollDepth" },
          maxDepth: { $max: "$scrollDepth" },
          events: { $sum: 1 },
        },
      },
      { $sort: { averageDepth: -1 } },
      { $limit: limit },
    ]),
    AnalyticsEvent.aggregate([
      {
        $match: {
          ...buildTimeMatch("timestamp", range),
          eventName: "page_exit",
          path: { $ne: "" },
          durationMs: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: "$path",
          averageDurationMs: { $avg: "$durationMs" },
          exits: { $sum: 1 },
        },
      },
      { $sort: { averageDurationMs: -1 } },
      { $limit: limit },
    ]),
  ]);

  return {
    topPages: topPages.map((row) => ({ path: row._id || "", views: Number(row.views || 0) })),
    exitPoints: exitPoints.map((row) => ({ path: row._id || "", exits: Number(row.exits || 0) })),
    ctaClicks: ctaClicks.map((row) => ({ ctaName: row._id || "", clicks: Number(row.clicks || 0) })),
    navigationPaths: navigationPaths.map((row) => ({
      fromPath: row._id?.fromPath || "",
      toPath: row._id?.toPath || "",
      count: Number(row.count || 0),
    })),
    scrollDepth: scrollDepth.map((row) => ({
      path: row._id || "",
      averageDepth: Number((row.averageDepth || 0).toFixed(2)),
      maxDepth: Number(row.maxDepth || 0),
      events: Number(row.events || 0),
    })),
    timeOnPage: timeOnPage.map((row) => ({
      path: row._id || "",
      averageDurationMs: Math.round(Number(row.averageDurationMs || 0)),
      exits: Number(row.exits || 0),
    })),
  };
};

router.get("/dashboard", async (req, res) => {
  try {
    const range = buildRange(req.query || {});
    const topLimit = clampTop(req.query.top);
    const todayRange = buildRange({ range: "today" });
    const last7dRange = buildRange({ range: "last7d" });
    const last30dRange = buildRange({ range: "last30d" });

    const [uniqueVisitors, visitorsToday, visitors7d, visitors30d, sessionMetrics, newVsReturning, searchInsights, funnelRows] =
      await Promise.all([
        getDistinctCount(buildTimeMatch("timestamp", range), visitorKeyExpr),
        getDistinctCount(buildTimeMatch("timestamp", todayRange), visitorKeyExpr),
        getDistinctCount(buildTimeMatch("timestamp", last7dRange), visitorKeyExpr),
        getDistinctCount(buildTimeMatch("timestamp", last30dRange), visitorKeyExpr),
        getSessionMetrics(range),
        getNewVsReturning(range),
        getSearchInsights(range, topLimit),
        getSessionFunnelRows(range),
      ]);

    const [
      usersRegistered,
      experiencesPublished,
      bookingsCreated,
      completedBookings,
      cancelledBookings,
      paidPaymentRows,
      topSourcesRows,
      topLandingPagesRows,
      deviceRows,
      browserRows,
      osRows,
      locationRows,
      experiencePerformance,
      behavior,
    ] = await Promise.all([
      User.countDocuments(buildTimeMatch("createdAt", range)),
      Experience.countDocuments(buildTimeMatch("createdAt", range)),
      Booking.countDocuments(buildTimeMatch("createdAt", range)),
      Booking.countDocuments({ ...buildTimeMatch("completedAt", range), status: { $in: COMPLETED_BOOKING_STATUSES } }),
      Booking.countDocuments({
        status: { $in: CANCELLED_BOOKING_STATUSES },
        $or: [buildTimeMatch("cancelledAt", range), buildTimeMatch("refundedAt", range), buildTimeMatch("updatedAt", range)],
      }),
      Payment.aggregate([
        { $match: { ...buildTimeMatch("updatedAt", range), status: "CONFIRMED" } },
        {
          $group: {
            _id: null,
            gmvMinor: { $sum: { $ifNull: ["$totalAmount", "$amount"] } },
            platformFeeMinor: { $sum: { $ifNull: ["$platformFee", 0] } },
            bookingIds: { $addToSet: "$booking" },
          },
        },
      ]),
      getTopTrafficRows({
        range,
        limit: topLimit,
        projectId: {
          source: {
            $cond: [exprHasValue("$source"), "$source", "$channelGroup"],
          },
          medium: { $cond: [exprHasValue("$medium"), "$medium", "none"] },
          campaign: { $cond: [exprHasValue("$campaign"), "$campaign", "(not set)"] },
          channelGroup: { $cond: [exprHasValue("$channelGroup"), "$channelGroup", "direct"] },
        },
        groupId: {
          _id: {
            source: "$source",
            medium: "$medium",
            campaign: "$campaign",
            channelGroup: "$channelGroup",
          },
          count: { $sum: 1 },
        },
      }),
      getTopTrafficRows({
        range,
        limit: topLimit,
        projectId: {
          landingPage: {
            $cond: [exprHasValue("$landingPage"), "$landingPage", "$path"],
          },
        },
        groupId: { _id: "$landingPage", count: { $sum: 1 } },
      }),
      getTopTrafficRows({
        range,
        limit: topLimit,
        projectId: {
          deviceType: {
            $cond: [exprHasValue("$deviceType"), "$deviceType", "unknown"],
          },
        },
        groupId: { _id: "$deviceType", count: { $sum: 1 } },
      }),
      getTopTrafficRows({
        range,
        limit: topLimit,
        projectId: {
          browser: {
            $cond: [exprHasValue("$browser"), "$browser", "unknown"],
          },
        },
        groupId: { _id: "$browser", count: { $sum: 1 } },
      }),
      getTopTrafficRows({
        range,
        limit: topLimit,
        projectId: {
          os: {
            $cond: [exprHasValue("$os"), "$os", "unknown"],
          },
        },
        groupId: { _id: "$os", count: { $sum: 1 } },
      }),
      getTopTrafficRows({
        range,
        limit: topLimit,
        projectId: {
          country: {
            $cond: [exprHasValue("$country"), "$country", "Unknown"],
          },
          city: {
            $cond: [exprHasValue("$city"), "$city", "Unknown"],
          },
        },
        groupId: {
          _id: { country: "$country", city: "$city" },
          count: { $sum: 1 },
        },
      }),
      getExperiencePerformance(range, topLimit),
      getBehaviorInsights(range, topLimit),
    ]);

    const hostsRegistered = await AnalyticsEvent.countDocuments({
      ...buildTimeMatch("timestamp", range),
      eventName: "host_registered",
    });

    const paidBookings = Number(Array.isArray(paidPaymentRows[0]?.bookingIds) ? paidPaymentRows[0].bookingIds.length : 0);
    const gmvMinor = Number(paidPaymentRows[0]?.gmvMinor || 0);
    const platformFeeMinor = Number(paidPaymentRows[0]?.platformFeeMinor || 0);
    const funnel = buildFunnel(funnelRows);
    const hostPerformance = await getHostPerformance(experiencePerformance, topLimit);

    return res.json({
      generatedAt: new Date().toISOString(),
      range: {
        key: range.key,
        label: range.label,
        start: range.start.toISOString(),
        endExclusive: range.end.toISOString(),
      },
      overview: {
        visitorsToday,
        visitorsLast7Days: visitors7d,
        visitorsLast30Days: visitors30d,
        uniqueVisitors,
        totalSessions: sessionMetrics.totalSessions,
        averageSessionDurationMs: sessionMetrics.averageSessionDurationMs,
        bounceRate: sessionMetrics.bounceRate,
        exitRate: sessionMetrics.exitRate,
        pageViews: sessionMetrics.pageViews,
        newUsers: newVsReturning.newUsers,
        returningUsers: newVsReturning.returningUsers,
        usersRegistered,
        hostsRegistered,
        experiencesPublished,
        bookingsCreated,
        paidBookings,
        completedBookings,
        cancelledBookings,
        gmvMinor,
        platformFeeRevenueEstimateMinor: platformFeeMinor,
      },
      traffic: {
        sources: topSourcesRows.map((row) => ({
          source: row._id?.source || "direct",
          medium: row._id?.medium || "none",
          campaign: row._id?.campaign || "(not set)",
          channelGroup: row._id?.channelGroup || "direct",
          sessions: Number(row.count || 0),
        })),
        topLandingPages: topLandingPagesRows.map((row) => ({
          path: row._id || "/",
          views: Number(row.count || 0),
        })),
        devices: deviceRows.map((row) => ({ deviceType: row._id || "unknown", sessions: Number(row.count || 0) })),
        browsers: browserRows.map((row) => ({ browser: row._id || "unknown", sessions: Number(row.count || 0) })),
        operatingSystems: osRows.map((row) => ({ os: row._id || "unknown", sessions: Number(row.count || 0) })),
        locations: locationRows.map((row) => ({
          country: row._id?.country || "Unknown",
          city: row._id?.city || "Unknown",
          sessions: Number(row.count || 0),
        })),
      },
      searchInsights: {
        ...searchInsights,
        conversion: {
          searchSessions: funnelRows.filter((row) => row.searchInitiated).length,
          searchToResultsRate: toRate(
            funnelRows.filter((row) => row.searchInitiated && row.searchResultsViewed).length,
            funnelRows.filter((row) => row.searchInitiated).length
          ),
          searchToExperienceRate: toRate(
            funnelRows.filter((row) => row.searchInitiated && row.experienceViewed).length,
            funnelRows.filter((row) => row.searchInitiated).length
          ),
          searchToBookingRate: toRate(
            funnelRows.filter((row) => row.searchInitiated && row.bookingStarted).length,
            funnelRows.filter((row) => row.searchInitiated).length
          ),
          searchToPaymentRate: toRate(
            funnelRows.filter((row) => row.searchInitiated && row.paymentCompleted).length,
            funnelRows.filter((row) => row.searchInitiated).length
          ),
        },
      },
      funnel,
      experiences: {
        topPerformers: experiencePerformance,
      },
      hosts: {
        topPerformers: hostPerformance,
      },
      behavior,
    });
  } catch (err) {
    console.error("Admin analytics dashboard error", err);
    return res.status(500).json({ message: "Failed to load analytics dashboard" });
  }
});

module.exports = router;
