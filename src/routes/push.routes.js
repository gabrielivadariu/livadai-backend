const { Router } = require("express");
const { savePushToken, removePushToken, sendTestPush, debugPushToken } = require("../controllers/push.controller");
const { authenticate } = require("../middleware/auth.middleware");

const router = Router();

router.post("/token", authenticate, savePushToken);
router.delete("/token", authenticate, removePushToken);
router.post("/test", authenticate, sendTestPush);
router.get("/debug", authenticate, debugPushToken);

module.exports = router;
