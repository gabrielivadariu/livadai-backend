const mongoose = require("mongoose");
const AnalyticsEvent = require("../models/analyticsEvent.model");

const ANALYTICS_TTL_DAYS = Math.max(30, Number(process.env.ANALYTICS_EVENT_TTL_DAYS || 365));
const SOCIAL_SOURCES = ["facebook", "instagram", "tiktok", "linkedin", "twitter", "x.com", "pinterest", "youtube"];
const SEARCH_SOURCES = ["google", "bing", "duckduckgo", "yahoo", "yandex"];
const PAID_MEDIUMS = ["cpc", "ppc", "paid", "paid_social", "display", "affiliate", "sponsored"];

const normalizeText = (value, maxLength = 220) => String(value || "").trim().slice(0, maxLength);

const normalizePath = (value) => {
  const cleaned = normalizeText(value, 320);
  if (!cleaned) return "";
  return cleaned.startsWith("/") ? cleaned : `/${cleaned.replace(/^\/+/, "")}`;
};

const normalizeList = (value, maxItems = 20, maxLength = 120) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
};

const normalizeTimestamp = (value) => {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
};

const normalizeNumber = (value, fallback = null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toObjectIdOrNull = (value) => {
  const raw = String(value || "").trim();
  if (!raw || !mongoose.Types.ObjectId.isValid(raw)) return null;
  return new mongoose.Types.ObjectId(raw);
};

const getRequestIp = (req) => {
  const forwarded = req?.headers?.["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req?.ip || req?.socket?.remoteAddress || "";
};

const getHeader = (req, name) => {
  const raw = req?.headers?.[name];
  if (Array.isArray(raw)) return normalizeText(raw[0] || "", 320);
  return normalizeText(raw || "", 320);
};

const parseUserAgent = (userAgent = "") => {
  const ua = String(userAgent || "").toLowerCase();

  let browser = "Other";
  if (ua.includes("edg/")) browser = "Edge";
  else if (ua.includes("opr/") || ua.includes("opera")) browser = "Opera";
  else if (ua.includes("firefox/")) browser = "Firefox";
  else if (ua.includes("samsungbrowser")) browser = "Samsung Internet";
  else if (ua.includes("chrome/") || ua.includes("crios/")) browser = "Chrome";
  else if (ua.includes("safari/")) browser = "Safari";

  let os = "Other";
  if (ua.includes("iphone") || ua.includes("ipad") || ua.includes("ios")) os = "iOS";
  else if (ua.includes("android")) os = "Android";
  else if (ua.includes("mac os x") || ua.includes("macintosh")) os = "macOS";
  else if (ua.includes("windows")) os = "Windows";
  else if (ua.includes("linux")) os = "Linux";

  let deviceType = "desktop";
  if (ua.includes("ipad") || ua.includes("tablet")) deviceType = "tablet";
  else if (ua.includes("mobi") || ua.includes("iphone") || ua.includes("android")) deviceType = "mobile";

  return { browser, os, deviceType };
};

const classifyChannelGroup = ({ source = "", medium = "", referrer = "" }) => {
  const sourceValue = String(source || "").toLowerCase();
  const mediumValue = String(medium || "").toLowerCase();
  const referrerValue = String(referrer || "").toLowerCase();

  if (PAID_MEDIUMS.some((token) => mediumValue.includes(token))) return "paid";
  if (!sourceValue && !mediumValue && !referrerValue) return "direct";
  if (SOCIAL_SOURCES.some((token) => sourceValue.includes(token) || referrerValue.includes(token))) return "social";
  if (SEARCH_SOURCES.some((token) => sourceValue.includes(token) || referrerValue.includes(token))) return "organic";
  if (sourceValue || referrerValue) return "referral";
  return "direct";
};

const readRequestAnalyticsContext = (req) => {
  const referrer = getHeader(req, "x-livadai-referrer") || getHeader(req, "referer");
  const source = normalizeText(getHeader(req, "x-livadai-source"), 120);
  const medium = normalizeText(getHeader(req, "x-livadai-medium"), 120);
  const campaign = normalizeText(getHeader(req, "x-livadai-campaign"), 120);

  return {
    anonymousId: normalizeText(getHeader(req, "x-livadai-anonymous-id"), 120),
    sessionId: normalizeText(getHeader(req, "x-livadai-session-id"), 120),
    source,
    medium,
    campaign,
    referrer,
    landingPage: normalizePath(getHeader(req, "x-livadai-landing-page")),
    path: normalizePath(getHeader(req, "x-livadai-path")),
    page: normalizePath(getHeader(req, "x-livadai-page")),
    title: normalizeText(getHeader(req, "x-livadai-title"), 220),
    channelGroup:
      normalizeText(getHeader(req, "x-livadai-channel-group"), 80) ||
      classifyChannelGroup({ source, medium, referrer }),
    platform: normalizeText(getHeader(req, "x-livadai-platform"), 40) || "web",
    appVersion: normalizeText(getHeader(req, "x-livadai-app-version"), 40),
  };
};

const readGeoContext = (req) => ({
  country:
    normalizeText(getHeader(req, "x-vercel-ip-country"), 80) ||
    normalizeText(getHeader(req, "cf-ipcountry"), 80) ||
    normalizeText(getHeader(req, "x-country"), 80),
  city:
    normalizeText(getHeader(req, "x-vercel-ip-city"), 120) ||
    normalizeText(getHeader(req, "x-city"), 120),
});

const buildVisitorKey = ({ userId, anonymousId, sessionId }) => {
  if (userId) return `user:${userId}`;
  if (anonymousId) return `anon:${anonymousId}`;
  if (sessionId) return `session:${sessionId}`;
  return "";
};

const buildEventDocument = ({
  req,
  rawEvent = {},
  userId,
  defaultPlatform = "server",
  contextOverride = {},
}) => {
  const requestContext = req ? readRequestAnalyticsContext(req) : {};
  const mergedContext = { ...requestContext, ...contextOverride };
  const userAgent = normalizeText(rawEvent.userAgent, 500) || getHeader(req, "user-agent");
  const deviceInfo = parseUserAgent(userAgent);
  const geo = req ? readGeoContext(req) : {};
  const timestamp = normalizeTimestamp(rawEvent.timestamp);
  const expiresAt = new Date(timestamp.getTime() + ANALYTICS_TTL_DAYS * 24 * 60 * 60 * 1000);
  const resolvedUserId = toObjectIdOrNull(rawEvent.userId || userId || mergedContext.userId);
  const anonymousId = normalizeText(rawEvent.anonymousId || mergedContext.anonymousId, 120);
  const sessionId = normalizeText(rawEvent.sessionId || mergedContext.sessionId, 120);
  const source = normalizeText(rawEvent.source || mergedContext.source, 120);
  const medium = normalizeText(rawEvent.medium || mergedContext.medium, 120);
  const campaign = normalizeText(rawEvent.campaign || mergedContext.campaign, 120);
  const referrer = normalizeText(rawEvent.referrer || mergedContext.referrer, 320);
  const path = normalizePath(rawEvent.path || rawEvent.page || mergedContext.path || mergedContext.page);
  const page = normalizePath(rawEvent.page || rawEvent.path || mergedContext.page || mergedContext.path);
  const landingPage = normalizePath(rawEvent.landingPage || mergedContext.landingPage || page || path);
  const visitorKey = buildVisitorKey({
    userId: resolvedUserId ? resolvedUserId.toString() : "",
    anonymousId,
    sessionId,
  });
  const properties =
    rawEvent.properties && typeof rawEvent.properties === "object" && !Array.isArray(rawEvent.properties)
      ? rawEvent.properties
      : {};

  return {
    eventName: normalizeText(rawEvent.eventName, 120).replace(/\s+/g, "_").toLowerCase(),
    timestamp,
    receivedAt: new Date(),
    expiresAt,
    visitorKey,
    anonymousId,
    sessionId,
    userId: resolvedUserId,
    platform: normalizeText(rawEvent.platform || mergedContext.platform || defaultPlatform, 40) || "unknown",
    page,
    path: path || page,
    title: normalizeText(rawEvent.title || mergedContext.title, 220),
    referrer,
    landingPage,
    source,
    medium,
    campaign,
    channelGroup:
      normalizeText(rawEvent.channelGroup || mergedContext.channelGroup, 80) ||
      classifyChannelGroup({ source, medium, referrer }),
    deviceType: normalizeText(rawEvent.deviceType, 40) || deviceInfo.deviceType,
    os: normalizeText(rawEvent.os, 80) || deviceInfo.os,
    browser: normalizeText(rawEvent.browser, 80) || deviceInfo.browser,
    country: normalizeText(rawEvent.country || geo.country, 80),
    city: normalizeText(rawEvent.city || geo.city, 120),
    experienceId: toObjectIdOrNull(rawEvent.experienceId || properties.experienceId),
    hostId: toObjectIdOrNull(rawEvent.hostId || properties.hostId),
    bookingId: toObjectIdOrNull(rawEvent.bookingId || properties.bookingId),
    paymentId: toObjectIdOrNull(rawEvent.paymentId || properties.paymentId),
    searchQuery: normalizeText(rawEvent.searchQuery || properties.searchQuery, 220),
    searchQueryNormalized: normalizeText(rawEvent.searchQuery || properties.searchQuery, 220).toLowerCase(),
    searchResultsCount: normalizeNumber(rawEvent.searchResultsCount ?? properties.searchResultsCount, null),
    searchLocation: normalizeText(rawEvent.searchLocation || properties.searchLocation, 120),
    searchCategory: normalizeText(rawEvent.searchCategory || properties.searchCategory, 120),
    searchFilters: normalizeList(rawEvent.searchFilters || properties.searchFilters, 20, 80),
    resultIds: normalizeList(rawEvent.resultIds || properties.resultIds, 50, 80),
    scrollDepth: normalizeNumber(rawEvent.scrollDepth ?? properties.scrollDepth, null),
    durationMs: normalizeNumber(rawEvent.durationMs ?? properties.durationMs, null),
    ctaName: normalizeText(rawEvent.ctaName || properties.ctaName, 120),
    appVersion: normalizeText(rawEvent.appVersion || mergedContext.appVersion, 40),
    properties,
  };
};

const insertAnalyticsEvents = async (rawEvents = [], options = {}) => {
  const docs = rawEvents
    .map((entry) =>
      buildEventDocument({
        req: options.req,
        rawEvent: entry,
        userId: options.userId,
        defaultPlatform: options.defaultPlatform,
        contextOverride: options.contextOverride,
      })
    )
    .filter((entry) => entry.eventName);

  if (!docs.length) return { stored: 0 };

  try {
    await AnalyticsEvent.insertMany(docs, { ordered: false });
    return { stored: docs.length };
  } catch (err) {
    if (docs.length === 1) {
      await AnalyticsEvent.create(docs[0]);
      return { stored: 1 };
    }
    console.error("Analytics insertMany error", err);
    throw err;
  }
};

const trackServerEvent = async ({
  req,
  eventName,
  userId,
  platform = "server",
  context = {},
  ...rawEvent
}) => {
  if (!eventName) return null;
  try {
    const doc = buildEventDocument({
      req,
      rawEvent: {
        eventName,
        platform,
        ...rawEvent,
      },
      userId,
      defaultPlatform: platform,
      contextOverride: context,
    });
    if (!doc.eventName) return null;
    return await AnalyticsEvent.create(doc);
  } catch (err) {
    console.error("Track server analytics event error", err);
    return null;
  }
};

module.exports = {
  ANALYTICS_TTL_DAYS,
  buildEventDocument,
  buildVisitorKey,
  classifyChannelGroup,
  getRequestIp,
  insertAnalyticsEvents,
  readRequestAnalyticsContext,
  trackServerEvent,
};
