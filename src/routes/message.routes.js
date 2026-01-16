const { Router } = require("express");
const {
  listMessages,
  sendMessage,
  listConversations,
} = require("../controllers/message.controller");
const { authenticate } = require("../middleware/auth.middleware");

const router = Router();

router.get("/", authenticate, listConversations);
router.get("/:bookingId", authenticate, listMessages);
router.post("/:bookingId", authenticate, sendMessage);

module.exports = router;
