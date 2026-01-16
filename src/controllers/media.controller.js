const fs = require("fs");
const path = require("path");
const cloudinary = require("cloudinary").v2;
const axios = require("axios");

const isRealValue = (v) => v && v !== "dummy";

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

const SAFE_LABELS = new Set(["LIKELY", "VERY_LIKELY"]);

const runSafeSearch = async (buffer) => {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!isRealValue(apiKey)) return { passed: true }; // Skip check if not configured/placeholder
  const body = {
    requests: [
      {
        image: { content: buffer.toString("base64") },
        features: [{ type: "SAFE_SEARCH_DETECTION" }],
      },
    ],
  };
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`;
  const { data } = await axios.post(url, body);
  const safe = data?.responses?.[0]?.safeSearchAnnotation;
  if (!safe) return { passed: true };
  const flags = [safe.adult, safe.violence, safe.racy];
  const blocked = flags.some((v) => SAFE_LABELS.has(v));
  return { passed: !blocked, annotation: safe };
};

const uploadToCloudinary = (fileBuffer, resourceType) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: resourceType || "auto" },
      (error, result) => {
        if (error) return reject(error);
        return resolve(result);
      }
    );
    stream.end(fileBuffer);
  });

const ensureLocalUploadDir = () => {
  const dir = path.join(__dirname, "..", "..", "uploads");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
};

const uploadMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const { buffer, mimetype, originalname } = req.file;

    if (mimetype && mimetype.startsWith("image/")) {
      const safeResult = await runSafeSearch(buffer);
      if (!safeResult.passed) {
        return res.status(400).json({
          message: "Upload blocked: potential adult/violent/racy content",
          detail: safeResult.annotation,
        });
      }
    }

    // Prefer Cloudinary if configured; otherwise fall back to local file save for development.
    if (hasCloudinary) {
      const resourceType = mimetype && mimetype.startsWith("video/") ? "video" : "auto";
      const result = await uploadToCloudinary(buffer, resourceType);

      return res.status(201).json({
        url: result.secure_url,
        public_id: result.public_id,
        resource_type: result.resource_type,
        originalname,
      });
    }

    // Local fallback: write to /uploads and serve statically
    const uploadsDir = ensureLocalUploadDir();
    const ext = mimetype?.split("/")?.[1] || "bin";
    const filename = `${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;
    const filepath = path.join(uploadsDir, filename);
    fs.writeFileSync(filepath, buffer);
    const url = `${process.env.PUBLIC_UPLOAD_BASE || "http://localhost:4000"}/uploads/${filename}`;

    return res.status(201).json({
      url,
      public_id: filename,
      resource_type: mimetype || "application/octet-stream",
      originalname,
    });
  } catch (err) {
    console.error("Media upload error", err);
    return res.status(500).json({ message: "Upload failed" });
  }
};

module.exports = { uploadMedia };
