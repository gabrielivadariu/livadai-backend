const mongoose = require("mongoose");

const experienceSchema = new mongoose.Schema(
  {
    host: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true },
    shortDescription: { type: String, maxlength: 50 },
    description: { type: String },
    category: { type: String },
    price: { type: Number },
    durationMinutes: { type: Number },
    currencyCode: { type: String, default: "EUR" },
    activityType: { type: String, enum: ["INDIVIDUAL", "GROUP"], default: "INDIVIDUAL" },
    maxParticipants: { type: Number, default: 1 },
    remainingSpots: { type: Number, default: 1 },
    soldOut: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["draft", "published", "cancelled", "CANCELLED", "DISABLED", "NO_BOOKINGS"],
      default: "published",
    },
    environment: { type: String, enum: ["INDOOR", "OUTDOOR", "BOTH"], default: "OUTDOOR" },
    // Schedule (new)
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    // Legacy fields kept for compatibility with existing screens/queries
    date: { type: String },
    startDate: { type: Date },
    endDate: { type: Date },
    startTime: { type: String },
    endTime: { type: String },
    country: { type: String },
    countryCode: { type: String },
    city: { type: String },
    street: { type: String },
    streetNumber: { type: String },
    address: { type: String },
    latitude: { type: Number },
    longitude: { type: Number },
    locationLat: { type: Number },
    locationLng: { type: Number },
    location: {
      formattedAddress: { type: String },
      city: { type: String },
      street: { type: String },
      streetNumber: { type: String },
      postalCode: { type: String },
      country: { type: String },
      lat: { type: Number },
      lng: { type: Number },
    },
    mainImageUrl: { type: String },
    images: [{ type: String }],
    videos: [{ type: String }],
    coverImageUrl: { type: String, default: null },
    mediaRefs: [
      {
        url: { type: String },
        publicId: { type: String },
        resourceType: { type: String, enum: ["image", "video", "raw"], default: "image" },
      },
    ],
    languages: { type: [String], default: [] },
    isActive: { type: Boolean, default: true },
    reminderHostSent: { type: Boolean, default: false },
    mediaCleanedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Experience", experienceSchema);
