const Booking = require("../models/booking.model");
const { isPayoutEligible } = require("./payout");

const aggregateHostBalances = async (hostId) => {
  const bookings = await Booking.find({ host: hostId });
  let available = 0;
  let pending = 0;
  let blocked = 0;

  for (const bk of bookings) {
    // amount is stored in minor units (cents/bani); convert to major units for display
    const amount = Number(bk.amount || 0) / 100;
    const deposit = Number(bk.depositAmount || 0) / 100;
    const amt = amount > 0 ? amount : deposit;
    if (amt <= 0) continue;

    const eligible = isPayoutEligible(bk);
    if (eligible) {
      available += amt;
      continue;
    }

    if (["PAID", "DEPOSIT_PAID", "PENDING_ATTENDANCE"].includes(bk.status)) {
      pending += amt;
      continue;
    }

    if (
      (bk.status === "COMPLETED" || bk.status === "DISPUTE_WON") &&
      bk.payoutEligibleAt &&
      new Date() < new Date(bk.payoutEligibleAt)
    ) {
      pending += amt;
      continue;
    }

    if (["DISPUTED", "DISPUTE_LOST", "NO_SHOW", "CANCELLED", "REFUNDED", "REFUND_FAILED"].includes(bk.status)) {
      blocked += amt;
      continue;
    }
  }

  return { available, pending, blocked };
};

module.exports = { aggregateHostBalances };
