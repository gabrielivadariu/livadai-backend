const { Router } = require("express");
const multer = require("multer");
const { uploadMedia } = require("../controllers/media.controller");

const upload = multer({ storage: multer.memoryStorage() });
const router = Router();

// Alias for image upload (uses the existing Cloudinary uploader)
router.post("/image", upload.single("file"), uploadMedia);

module.exports = router;
