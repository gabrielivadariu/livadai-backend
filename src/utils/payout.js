const isPayoutEligible = (booking) => {
  if (!booking) return false;
  const now = new Date();
  if (!["COMPLETED", "AUTO_COMPLETED"].includes(booking.status)) return false;
  if (!booking.payoutEligibleAt) return false;
  if (now < new Date(booking.payoutEligibleAt)) return false;
  if (booking.status === "DISPUTED" || booking.disputedAt) return false;
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
