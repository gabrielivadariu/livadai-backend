const { Router } = require("express");
const { savePushToken, sendTestPush } = require("../controllers/push.controller");
const { authenticate } = require("../middleware/auth.middleware");

const router = Router();

router.post("/token", authenticate, savePushToken);
router.post("/test", authenticate, sendTestPush);

module.exports = router;
