const { Router } = require("express");
const { savePushToken, sendTestPush, debugPushToken } = require("../controllers/push.controller");
const { authenticate } = require("../middleware/auth.middleware");

const router = Router();

router.post("/token", authenticate, savePushToken);
router.post("/test", authenticate, sendTestPush);
router.get("/debug", authenticate, debugPushToken);

module.exports = router;
