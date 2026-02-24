const mongoose = require("mongoose");

const adminAuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    actorEmail: { type: String, required: true, index: true },
    actionType: { type: String, required: true, index: true },
    targetType: { type: String, required: true, index: true },
    targetId: { type: String, required: true, index: true },
    reason: { type: String },
    diff: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String },
    userAgent: { type: String },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "admin_audit_logs",
  }
);

adminAuditLogSchema.index({ createdAt: -1, actionType: 1 });

module.exports = mongoose.model("AdminAuditLog", adminAuditLogSchema);
