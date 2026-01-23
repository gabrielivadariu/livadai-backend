const { Router } = require("express");
const {
  createBooking,
  getMyBookings,
  getHostBookings,
  getHostBookingsByExperience,
  cancelBookingByHost,
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
router.get("/host/experience/:experienceId", authenticate, authorize(["HOST", "BOTH"]), getHostBookingsByExperience);
router.post("/:id/attendance", authenticate, authorize(["HOST"]), updateAttendance); // legacy
router.post("/:id/confirm-attendance", authenticate, authorize(["HOST"]), confirmAttendance);
router.post("/:id/no-show", authenticate, authorize(["HOST"]), markNoShow);
router.post("/:id/cancel-by-host", authenticate, authorize(["HOST", "BOTH"]), cancelBookingByHost);
router.post("/:id/dispute", authenticate, authorize(["EXPLORER", "HOST", "BOTH"]), disputeBooking);
router.post("/report-content", authenticate, reportContent);
router.post("/report-user", authenticate, reportUser);
router.get("/:id", authenticate, async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate("experience", "title startsAt endsAt startDate endDate activityType maxParticipants remainingSpots")
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
    if (obj.experience?._id) {
      try {
        const bookedAgg = await Booking.aggregate([
          { $match: { experience: booking.experience, status: { $in: ["PAID", "COMPLETED", "DEPOSIT_PAID", "PENDING_ATTENDANCE"] } } },
          { $group: { _id: "$experience", booked: { $sum: { $ifNull: ["$quantity", 1] } } } },
        ]);
        const booked = bookedAgg?.[0]?.booked || 0;
        const total = obj.experience.maxParticipants || 1;
        obj.experience.availableSpots = Math.max(0, total - booked);
        obj.experience.bookedSpots = booked;
      } catch (err) {
        console.error("Booking detail booked spots error", err);
      }
    }
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
