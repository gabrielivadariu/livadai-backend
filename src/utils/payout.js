const isPayoutEligible = (booking) => {
  if (!booking) return false;
  const now = new Date();
  if (!["COMPLETED", "AUTO_COMPLETED", "DISPUTE_WON"].includes(booking.status)) return false;
  if (!booking.payoutEligibleAt) return false;
  if (now < new Date(booking.payoutEligibleAt)) return false;
  if (booking.status === "DISPUTED") return false;
  if (booking.status === "DISPUTE_LOST") return false;
  if (booking.disputedAt && !booking.disputeResolvedAt) return false;
  return true;
};

const logPayoutAttempt = (booking, result) => {
  const now = new Date();
  console.log(
    `[PAYOUT_CHECK] booking=${booking?._id || "n/a"} status=${booking?.status} payoutEligibleAt=${
      booking?.payoutEligibleAt
    } now=${now.toISOString()} result=${result}`
  );
};

module.exports = { isPayoutEligible, logPayoutAttempt };
