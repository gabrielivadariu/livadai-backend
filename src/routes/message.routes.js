const { Router } = require("express");
const {
  listMessages,
  sendMessage,
  listConversations,
  unreadMessagesCount,
  markMessagesRead,
} = require("../controllers/message.controller");
const { authenticate } = require("../middleware/auth.middleware");

const router = Router();

router.get("/", authenticate, listConversations);
router.get("/unread-count", authenticate, unreadMessagesCount);
router.post("/mark-read", authenticate, markMessagesRead);
router.get("/:bookingId", authenticate, listMessages);
router.post("/:bookingId", authenticate, sendMessage);

module.exports = router;
