const mongoose = require("mongoose");

const secondaryExperienceSchema = new mongoose.Schema(
  {
    title: { type: String, trim: true },
    summary: { type: String, trim: true },
  },
  { _id: false }
);

const emailMarketingCampaignSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["TEST", "SUBSCRIBER_SEND"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["QUEUED", "SENDING", "SENT", "PARTIAL", "FAILED"],
      default: "QUEUED",
      index: true,
    },
    requestedById: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    requestedByEmail: { type: String, required: true, index: true, trim: true },
    subject: { type: String, required: true, trim: true },
    introText: { type: String, required: true, trim: true },
    mainExperience: {
      title: { type: String, required: true, trim: true },
      summary: { type: String, required: true, trim: true },
    },
    secondaryExperiences: {
      type: [secondaryExperienceSchema],
      default: [],
    },
    ctaLabel: { type: String, required: true, trim: true },
    ctaUrl: { type: String, required: true, trim: true },
    testEmail: { type: String, trim: true, default: "" },
    audienceCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    transportMode: { type: String, trim: true, default: "" },
    lastError: { type: String, trim: true, default: "" },
    lastErrorAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: "email_marketing_campaigns",
  }
);

emailMarketingCampaignSchema.index({ createdAt: -1, kind: 1 });

module.exports = mongoose.model("EmailMarketingCampaign", emailMarketingCampaignSchema);
