const { Router } = require("express");
const multer = require("multer");
const { uploadMedia } = require("../controllers/media.controller");

const MAX_MEDIA_FILE_SIZE_BYTES = 12 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_FILE_SIZE_BYTES },
});
const router = Router();

const uploadSingleFile = (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ code: "MEDIA_FILE_TOO_LARGE", message: "File too large. Maximum size is 12 MB." });
    }
    return res.status(400).json({ message: "Upload failed" });
  });
};

// Alias for image upload (uses the existing Cloudinary uploader)
router.post("/image", uploadSingleFile, uploadMedia);

module.exports = router;
