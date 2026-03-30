const mongoose = require("mongoose");

const analyticsEventSchema = new mongoose.Schema(
  {
    eventName: { type: String, required: true, trim: true },
    timestamp: { type: Date, required: true, index: true },
    receivedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, index: { expireAfterSeconds: 0 } },
    visitorKey: { type: String, default: "", index: true },
    anonymousId: { type: String, default: "", index: true },
    sessionId: { type: String, default: "", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    platform: { type: String, default: "unknown", index: true },
    page: { type: String, default: "" },
    path: { type: String, default: "", index: true },
    title: { type: String, default: "" },
    referrer: { type: String, default: "" },
    landingPage: { type: String, default: "" },
    source: { type: String, default: "", index: true },
    medium: { type: String, default: "", index: true },
    campaign: { type: String, default: "" },
    channelGroup: { type: String, default: "", index: true },
    deviceType: { type: String, default: "" },
    os: { type: String, default: "" },
    browser: { type: String, default: "" },
    country: { type: String, default: "" },
    city: { type: String, default: "" },
    experienceId: { type: mongoose.Schema.Types.ObjectId, ref: "Experience", default: null, index: true },
    hostId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: "Booking", default: null, index: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null, index: true },
    searchQuery: { type: String, default: "" },
    searchQueryNormalized: { type: String, default: "", index: true },
    searchResultsCount: { type: Number, default: null },
    searchLocation: { type: String, default: "" },
    searchCategory: { type: String, default: "" },
    searchFilters: { type: [String], default: [] },
    resultIds: { type: [String], default: [] },
    scrollDepth: { type: Number, default: null },
    durationMs: { type: Number, default: null },
    ctaName: { type: String, default: "" },
    appVersion: { type: String, default: "" },
    properties: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    collection: "analytics_events",
    minimize: false,
  }
);

analyticsEventSchema.index({ eventName: 1, timestamp: -1 });
analyticsEventSchema.index({ sessionId: 1, timestamp: -1 });
analyticsEventSchema.index({ visitorKey: 1, timestamp: -1 });
analyticsEventSchema.index({ platform: 1, timestamp: -1 });
analyticsEventSchema.index({ source: 1, medium: 1, timestamp: -1 });
analyticsEventSchema.index({ experienceId: 1, eventName: 1, timestamp: -1 });
analyticsEventSchema.index({ hostId: 1, eventName: 1, timestamp: -1 });

module.exports = mongoose.model("AnalyticsEvent", analyticsEventSchema);
