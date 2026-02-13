const mongoose = require("mongoose");

const mediaDeletionLogSchema = new mongoose.Schema(
  {
    scope: { type: String, required: true },
    requestedCount: { type: Number, default: 0 },
    deletedCount: { type: Number, default: 0 },
    entityType: { type: String, enum: ["experience", "user", "host", "system"], default: "system" },
    entityId: { type: String },
    reason: { type: String },
    details: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

mediaDeletionLogSchema.index({ createdAt: -1, scope: 1 });

module.exports = mongoose.model("MediaDeletionLog", mediaDeletionLogSchema);
