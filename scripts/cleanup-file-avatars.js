require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../src/models/user.model");

const isFileUri = (value) => typeof value === "string" && value.trim().toLowerCase().startsWith("file://");

const run = async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("Missing MONGO_URI (or MONGODB_URI) in environment.");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  const res = await User.updateMany(
    {
      $or: [
        { avatar: { $regex: "^file://", $options: "i" } },
        { profilePhoto: { $regex: "^file://", $options: "i" } },
        { "hostProfile.avatar": { $regex: "^file://", $options: "i" } },
      ],
    },
    [
      {
        $set: {
          avatar: {
            $cond: [{ $regexMatch: { input: "$avatar", regex: /^file:\/\//i } }, "", "$avatar"],
          },
          profilePhoto: {
            $cond: [{ $regexMatch: { input: "$profilePhoto", regex: /^file:\/\//i } }, "", "$profilePhoto"],
          },
          "hostProfile.avatar": {
            $cond: [{ $regexMatch: { input: "$hostProfile.avatar", regex: /^file:\/\//i } }, "", "$hostProfile.avatar"],
          },
        },
      },
    ]
  );

  console.log("Cleanup complete.", {
    matched: res.matchedCount ?? res.n,
    modified: res.modifiedCount ?? res.nModified,
  });

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
