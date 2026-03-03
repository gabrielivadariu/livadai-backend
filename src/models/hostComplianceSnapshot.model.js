const mongoose = require("mongoose");

const hostComplianceSnapshotSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    stripeAccountId: { type: String, index: true, required: true },
    livadaiName: { type: String, default: "" },
    livadaiEmail: { type: String, default: "" },
    stripeBusinessType: { type: String, default: "" },
    stripeLegalName: { type: String, default: "" },
    stripeDisplayName: { type: String, default: "" },
    nameMatchState: {
      type: String,
      enum: ["MATCH", "MISMATCH", "MISSING_STRIPE_NAME", "MISSING_LIVADAI_NAME", "UNKNOWN"],
      default: "UNKNOWN",
      index: true,
    },
    externalAccountId: { type: String, default: "" },
    bankName: { type: String, default: "" },
    bankLast4: { type: String, default: "" },
    bankCountry: { type: String, default: "" },
    bankCurrency: { type: String, default: "" },
    isStripeChargesEnabled: { type: Boolean, default: false },
    isStripePayoutsEnabled: { type: Boolean, default: false },
    isStripeDetailsSubmitted: { type: Boolean, default: false },
    requirementsDisabledReason: { type: String, default: "" },
    requirementsCurrentlyDue: { type: [String], default: [] },
    requirementsEventuallyDue: { type: [String], default: [] },
    requirementsPastDue: { type: [String], default: [] },
    requirementsPendingVerification: { type: [String], default: [] },
    triggerType: { type: String, default: "unknown" },
    triggerEventId: { type: String, default: "" },
    triggerEventType: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: "host_compliance_snapshots",
  }
);

hostComplianceSnapshotSchema.index({ user: 1, createdAt: -1 });
hostComplianceSnapshotSchema.index({ stripeAccountId: 1, createdAt: -1 });
hostComplianceSnapshotSchema.index({ createdAt: -1, nameMatchState: 1 });

module.exports = mongoose.model("HostComplianceSnapshot", hostComplianceSnapshotSchema);
