const { Router } = require("express");
const { optionalAuthenticate } = require("../middleware/auth.middleware");
const { insertAnalyticsEvents } = require("../utils/analytics");

const router = Router();
const MAX_EVENTS_PER_BATCH = 50;

router.post("/events/batch", optionalAuthenticate, async (req, res) => {
  try {
    const body = req.body || {};
    const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_BATCH) : body.event ? [body.event] : [];
    if (!events.length) {
      return res.status(400).json({ message: "events array required" });
    }

    const stored = await insertAnalyticsEvents(events, {
      req,
      userId: req.user?.id,
      defaultPlatform: "web",
    });

    return res.status(201).json({
      received: events.length,
      stored: stored.stored || 0,
    });
  } catch (err) {
    console.error("Analytics ingest error", err);
    return res.status(500).json({ message: "Failed to ingest analytics events" });
  }
});

module.exports = router;
