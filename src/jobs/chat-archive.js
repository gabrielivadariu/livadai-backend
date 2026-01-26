const Booking = require("../models/booking.model");

const computeEndDate = (booking) => {
  const exp = booking.experience || {};
  const expEnd = exp.endsAt || exp.endDate;
  const expStart = exp.startsAt || exp.startDate;
  const durationMinutes = exp.durationMinutes;
  const startDate = expStart ? new Date(expStart) : null;
  let endDate = expEnd ? new Date(expEnd) : null;
  if (!endDate && startDate && durationMinutes) {
    if (!Number.isNaN(startDate.getTime())) {
      endDate = new Date(startDate.getTime() + Number(durationMinutes) * 60 * 1000);
    }
  }
  if (!endDate && startDate) {
    if (!Number.isNaN(startDate.getTime())) {
      endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  if (endDate && Number.isNaN(endDate.getTime())) return null;
  return endDate;
};

const setupChatArchiveJob = () => {
  setInterval(async () => {
    const now = new Date();
    try {
      const bookings = await Booking.find({
        $or: [{ chatArchivedAt: { $exists: false } }, { chatArchivedAt: null }],
        status: { $in: ["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE", "COMPLETED", "AUTO_COMPLETED", "NO_SHOW", "DISPUTED", "DISPUTE_WON", "DISPUTE_LOST"] },
      }).populate("experience", "startsAt endsAt startDate endDate durationMinutes");

      for (const bk of bookings) {
        if (bk.status === "DISPUTED") continue;
        let archiveAt = null;
        if (bk.disputeResolvedAt) {
          archiveAt = new Date(new Date(bk.disputeResolvedAt).getTime() + 72 * 60 * 60 * 1000);
        } else {
          const endDate = computeEndDate(bk);
          if (!endDate) continue;
          archiveAt = new Date(endDate.getTime() + 48 * 60 * 60 * 1000);
        }
        if (archiveAt && archiveAt <= now) {
          bk.chatArchivedAt = archiveAt;
          await bk.save();
        }
      }
    } catch (err) {
      console.error("Chat archive job error", err);
    }
  }, 30 * 60 * 1000);
};

module.exports = setupChatArchiveJob;
