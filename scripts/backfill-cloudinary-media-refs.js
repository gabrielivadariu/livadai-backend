require("dotenv").config();
const mongoose = require("mongoose");
const Experience = require("../src/models/experience.model");
const User = require("../src/models/user.model");
const { getCloudinaryInfo, getTargetKey } = require("../src/utils/cloudinary-media");

const dryRun = process.argv.includes("--dry-run");

const normalizeRef = (ref) => {
  if (!ref || typeof ref !== "object") return null;
  if (!ref.publicId) return null;
  return {
    url: ref.url || "",
    publicId: ref.publicId,
    resourceType: ref.resourceType || "image",
  };
};

const refsToKeySet = (refs) => {
  const out = new Set();
  for (const ref of refs || []) {
    const key = getTargetKey(ref);
    if (key) out.add(key);
  }
  return out;
};

const buildExperienceRefs = (doc) => {
  const urls = [
    ...(Array.isArray(doc.images) ? doc.images : []),
    ...(Array.isArray(doc.videos) ? doc.videos : []),
    doc.mainImageUrl,
    doc.coverImageUrl,
  ].filter(Boolean);

  const refs = [];
  const seen = new Set();
  for (const url of urls) {
    const info = getCloudinaryInfo(url);
    if (!info) continue;
    const ref = {
      url,
      publicId: info.publicId,
      resourceType: info.resourceType,
    };
    const key = getTargetKey(ref);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
};

const backfillExperiences = async () => {
  let scanned = 0;
  let changed = 0;

  const cursor = Experience.find(
    {},
    "_id images videos mainImageUrl coverImageUrl mediaRefs"
  ).cursor();

  for await (const exp of cursor) {
    scanned += 1;
    const currentRefs = (Array.isArray(exp.mediaRefs) ? exp.mediaRefs : [])
      .map(normalizeRef)
      .filter(Boolean);
    const nextRefs = buildExperienceRefs(exp);

    const currentKeys = refsToKeySet(currentRefs);
    const nextKeys = refsToKeySet(nextRefs);
    const isSame =
      currentKeys.size === nextKeys.size &&
      Array.from(nextKeys).every((key) => currentKeys.has(key));

    if (isSame) continue;
    changed += 1;

    if (!dryRun) {
      await Experience.updateOne(
        { _id: exp._id },
        {
          $set: {
            mediaRefs: nextRefs,
          },
        }
      );
    }
  }

  return { scanned, changed };
};

const backfillUsers = async () => {
  let scanned = 0;
  let changed = 0;

  const cursor = User.find(
    {},
    "_id avatar profilePhoto avatarPublicId avatarResourceType"
  ).cursor();

  for await (const user of cursor) {
    scanned += 1;
    const avatarUrl = user.avatar || user.profilePhoto || "";
    const info = getCloudinaryInfo(avatarUrl);

    let nextPublicId = null;
    let nextResourceType = null;
    if (info) {
      nextPublicId = info.publicId;
      nextResourceType = info.resourceType;
    }

    const currentPublicId = user.avatarPublicId || null;
    const currentResourceType = user.avatarResourceType || null;

    const needsUpdate =
      currentPublicId !== nextPublicId || currentResourceType !== nextResourceType;

    if (!needsUpdate) continue;
    changed += 1;

    if (!dryRun) {
      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            avatarPublicId: nextPublicId,
            avatarResourceType: nextResourceType,
          },
        }
      );
    }
  }

  return { scanned, changed };
};

const run = async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("Missing MONGO_URI (or MONGODB_URI) in environment.");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  const experiences = await backfillExperiences();
  const users = await backfillUsers();

  console.log("Cloudinary backfill complete.", {
    dryRun,
    experiences,
    users,
  });

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("Cloudinary backfill failed:", err);
  process.exit(1);
});
