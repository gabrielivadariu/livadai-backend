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

const deleteCloudinaryUrl = async (url, context = {}) => {
  if (!hasCloudinary) return false;
  const info = getCloudinaryInfo(url);
  if (!info) return false;
  try {
    await cloudinary.uploader.destroy(info.publicId, { resource_type: info.resourceType });
    return true;
  } catch (err) {
    console.error("Cloudinary delete failed", {
      scope: context.scope || "unknown",
      url,
      err: err?.message || err,
    });
    return false;
  }
};

const deleteCloudinaryUrls = async (urls, context = {}) => {
  const unique = Array.from(new Set((urls || []).filter(Boolean)));
  let deleted = 0;
  for (const url of unique) {
    const removed = await deleteCloudinaryUrl(url, context);
    if (removed) deleted += 1;
  }
  return deleted;
};

module.exports = {
  hasCloudinary,
  getCloudinaryInfo,
  deleteCloudinaryUrl,
  deleteCloudinaryUrls,
};
