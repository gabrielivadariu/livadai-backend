require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/user.model");
const { syncHostComplianceSnapshot } = require("../src/utils/hostCompliance");

const run = async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("Missing MONGO_URI (or MONGODB_URI) in environment.");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  const hosts = await User.find({
    role: { $in: ["HOST", "BOTH"] },
    stripeAccountId: { $nin: [null, ""] },
  }).select("_id email stripeAccountId");

  let success = 0;
  let failed = 0;

  for (const host of hosts) {
    try {
      await syncHostComplianceSnapshot({
        userId: host._id,
        stripeAccountId: host.stripeAccountId,
        triggerType: "backfill_script",
        metadata: {
          script: "backfill-host-compliance-snapshots",
        },
      });
      success += 1;
    } catch (err) {
      failed += 1;
      console.error("Backfill failed for host", {
        hostId: String(host._id),
        email: host.email || "",
        error: err?.message || String(err),
      });
    }
  }

  console.log("Host compliance snapshot backfill completed.", {
    totalHosts: hosts.length,
    success,
    failed,
  });

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("Host compliance backfill script failed:", err);
  process.exit(1);
});
