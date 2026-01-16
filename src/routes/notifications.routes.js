const { Router } = require("express");
const { listNotifications, markRead, markAllRead, unreadCount } = require("../controllers/notifications.controller");
const { authenticate } = require("../middleware/auth.middleware");

const router = Router();

router.get("/", authenticate, listNotifications);
router.post("/mark-read", authenticate, markRead);
router.post("/mark-all-read", authenticate, markAllRead);
router.get("/unread-count", authenticate, unreadCount);

module.exports = router;
