const { Router } = require("express");
const {
  createBooking,
  getMyBookings,
  getHostBookings,
  updateAttendance,
  confirmAttendance,
  markNoShow,
  disputeBooking,
  reportContent,
  reportUser,
} = require("../controllers/booking.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");
const Booking = require("../models/booking.model");

const router = Router();

router.post("/", authenticate, authorize(["EXPLORER", "HOST", "BOTH"]), createBooking);
router.get("/me", authenticate, authorize(["EXPLORER", "HOST", "BOTH"]), getMyBookings);
router.get("/host", authenticate, authorize(["HOST"]), getHostBookings);
router.post("/:id/attendance", authenticate, authorize(["HOST"]), updateAttendance); // legacy
router.post("/:id/confirm-attendance", authenticate, authorize(["HOST"]), confirmAttendance);
router.post("/:id/no-show", authenticate, authorize(["HOST"]), markNoShow);
router.post("/:id/dispute", authenticate, authorize(["EXPLORER", "HOST", "BOTH"]), disputeBooking);
router.post("/report-content", authenticate, reportContent);
router.post("/report-user", authenticate, reportUser);
router.get("/:id", authenticate, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate("experience", "title startsAt endsAt startDate endDate activityType")
      .populate("explorer", "name displayName profilePhoto avatar phone");
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    const hostId = booking.host?._id?.toString?.() || booking.host?.toString?.() || booking.host;
    const explorerId = booking.explorer?._id?.toString?.() || booking.explorer?.toString?.() || booking.explorer;
    if (hostId !== req.user.id && explorerId !== req.user.id) {
      return res.status(403).json({ message: "Forbidden" });
    }
    const allowedStatuses = new Set(["PAID", "COMPLETED", "DEPOSIT_PAID", "PENDING_ATTENDANCE"]);
    let canViewClientPhone = false;
    const isHost = booking.host.toString() === req.user.id;
    if (isHost && allowedStatuses.has(booking.status)) {
      canViewClientPhone = true;
    }
    const obj = booking.toObject();
    if (!canViewClientPhone && obj.explorer) {
      delete obj.explorer.phone;
    }
    obj.canViewClientPhone = canViewClientPhone;
    return res.json(obj);
  } catch (err) {
    console.error("Get booking error", err);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
