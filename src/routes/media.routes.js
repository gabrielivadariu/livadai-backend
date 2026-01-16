const { Router } = require("express");
const multer = require("multer");
const { uploadMedia } = require("../controllers/media.controller");

const upload = multer({ storage: multer.memoryStorage() });

const router = Router();

router.post("/upload", upload.single("file"), uploadMedia);

module.exports = router;
