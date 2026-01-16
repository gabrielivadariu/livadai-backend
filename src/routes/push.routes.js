const { Router } = require("express");
const { savePushToken } = require("../controllers/push.controller");
const { authenticate } = require("../middleware/auth.middleware");

const router = Router();

router.post("/token", authenticate, savePushToken);

module.exports = router;
