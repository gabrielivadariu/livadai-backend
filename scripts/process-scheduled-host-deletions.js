require("dotenv").config();
const mongoose = require("mongoose");
const { processScheduledHostDeletions } = require("../src/jobs/scheduled-host-deletions");

const run = async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("Missing MONGO_URI (or MONGODB_URI) in environment.");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  const outcome = await processScheduledHostDeletions();
  if (!outcome.due) {
    console.log("No scheduled host deletions due.");
    await mongoose.disconnect();
    return;
  }

  console.log("Scheduled host deletions processed.", {
    due: outcome.due,
    deleted: outcome.deleted,
    at: new Date().toISOString(),
  });

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("Scheduled host deletions job failed:", err);
  process.exit(1);
});
