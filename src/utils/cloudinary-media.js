const cloudinary = require("cloudinary").v2;

const isRealValue = (value) => value && value !== "dummy";

const hasCloudinary =
  isRealValue(process.env.CLOUDINARY_CLOUD_NAME) &&
  isRealValue(process.env.CLOUDINARY_API_KEY) &&
  isRealValue(process.env.CLOUDINARY_API_SECRET);

if (hasCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

const getCloudinaryInfo = (url) => {
  if (!url || typeof url !== "string") return null;
  if (!url.includes("res.cloudinary.com") || !url.includes("/upload/")) return null;
  const resourceType = url.includes("/video/upload/")
    ? "video"
    : url.includes("/raw/upload/")
      ? "raw"
      : "image";
  const parts = url.split("/upload/");
  if (parts.length < 2) return null;
  let publicPath = parts[1].split("?")[0];
  const versionSplit = publicPath.split(/\/v\d+\//);
  if (versionSplit.length > 1) {
    publicPath = versionSplit[versionSplit.length - 1];
  }
  publicPath = publicPath.replace(/\.[^/.]+$/, "");
  if (!publicPath) return null;
  return { publicId: publicPath, resourceType };
};

const normalizeCloudinaryTarget = (target) => {
  if (!target) return null;
  if (typeof target === "string") {
    const info = getCloudinaryInfo(target);
    if (!info) return null;
    return {
      url: target,
      publicId: info.publicId,
      resourceType: info.resourceType,
    };
  }
  if (typeof target === "object") {
    if (target.publicId) {
      return {
        url: target.url,
        publicId: target.publicId,
        resourceType: target.resourceType || "image",
      };
    }
    if (target.url) {
      const info = getCloudinaryInfo(target.url);
      if (!info) return null;
      return {
        url: target.url,
        publicId: info.publicId,
        resourceType: info.resourceType,
      };
    }
  }
  return null;
};

const getTargetKey = (target) => {
  if (!target) return "";
  if (target.publicId) return `${target.resourceType || "image"}:${target.publicId}`;
  return target.url || "";
};

const deleteCloudinaryUrl = async (target, context = {}) => {
  if (!hasCloudinary) return false;
  const normalized = normalizeCloudinaryTarget(target);
  if (!normalized) return false;
  try {
    await cloudinary.uploader.destroy(normalized.publicId, { resource_type: normalized.resourceType });
    return true;
  } catch (err) {
    console.error("Cloudinary delete failed", {
      scope: context.scope || "unknown",
      url: normalized.url,
      publicId: normalized.publicId,
      err: err?.message || err,
    });
    return false;
  }
};

const deleteCloudinaryUrls = async (targets, context = {}) => {
  const normalized = (targets || [])
    .map((item) => normalizeCloudinaryTarget(item))
    .filter(Boolean);
  const seen = new Set();
  const unique = normalized.filter((item) => {
    const key = getTargetKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let deleted = 0;
  for (const target of unique) {
    const removed = await deleteCloudinaryUrl(target, context);
    if (removed) deleted += 1;
  }
  return deleted;
};

module.exports = {
  hasCloudinary,
  getCloudinaryInfo,
  normalizeCloudinaryTarget,
  getTargetKey,
  deleteCloudinaryUrl,
  deleteCloudinaryUrls,
};
