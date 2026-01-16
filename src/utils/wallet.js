const Booking = require("../models/booking.model");
const { isPayoutEligible } = require("./payout");

const aggregateHostBalances = async (hostId) => {
  const bookings = await Booking.find({ host: hostId });
  let available = 0;
  let pending = 0;
  let blocked = 0;

  for (const bk of bookings) {
    // amount is stored in minor units (cents/bani); convert to major units for display
    const amt = Number(bk.amount || 0) / 100;
    const eligible = isPayoutEligible(bk);
    if (eligible) {
      available += amt;
      continue;
    }

    if (bk.status === "COMPLETED" && bk.payoutEligibleAt && new Date() < new Date(bk.payoutEligibleAt)) {
      pending += amt;
      continue;
    }

    if (["DISPUTED", "NO_SHOW", "CANCELLED"].includes(bk.status)) {
      blocked += amt;
      continue;
    }
  }

  return { available, pending, blocked };
};

module.exports = { aggregateHostBalances };
