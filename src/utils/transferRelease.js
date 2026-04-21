const Report = require("../models/report.model");

const OPEN_REPORT_STATUSES = ["OPEN", "INVESTIGATING"];
const ELIGIBLE_BOOKING_STATUSES = ["COMPLETED", "AUTO_COMPLETED", "DISPUTE_WON"];

const getBlockingReportCount = async (bookingId) => {
  if (!bookingId) return 0;
  return Report.countDocuments({
    booking: bookingId,
    status: { $in: OPEN_REPORT_STATUSES },
    $or: [{ affectsPayout: true }, { type: { $in: ["BOOKING_DISPUTE", "STRIPE_DISPUTE"] } }],
  });
};

const evaluateTransferRelease = async ({ booking, payment }) => {
  if (!booking || !payment) {
    return {
      eligible: false,
      readyAt: null,
      reason: "missing_booking_or_payment",
    };
  }

  if (String(payment.chargeModel || "DESTINATION_CHARGE") !== "SEPARATE_CHARGE_AND_TRANSFER") {
    return {
      eligible: false,
      readyAt: booking.payoutEligibleAt || null,
      reason: "charge_model_not_supported",
    };
  }

  if (String(payment.status || "") !== "CONFIRMED") {
    return {
      eligible: false,
      readyAt: booking.payoutEligibleAt || null,
      reason: "payment_not_confirmed",
    };
  }

  if (String(payment.transferStatus || "") === "TRANSFERRED") {
    return {
      eligible: false,
      readyAt: payment.transferReadyAt || booking.payoutEligibleAt || null,
      reason: "already_transferred",
    };
  }

  if (!ELIGIBLE_BOOKING_STATUSES.includes(String(booking.status || ""))) {
    return {
      eligible: false,
      readyAt: booking.payoutEligibleAt || null,
      reason: "booking_not_completed",
    };
  }

  if (!booking.payoutEligibleAt) {
    return {
      eligible: false,
      readyAt: null,
      reason: "missing_payout_eligibility_date",
    };
  }

  const readyAt = new Date(booking.payoutEligibleAt);
  if (Number.isNaN(readyAt.getTime())) {
    return {
      eligible: false,
      readyAt: null,
      reason: "invalid_payout_eligibility_date",
    };
  }

  if (new Date() < readyAt) {
    return {
      eligible: false,
      readyAt,
      reason: "cooldown_not_elapsed",
    };
  }

  if (booking.refundedAt || ["REFUNDED", "REFUND_FAILED", "CANCELLED", "DISPUTED", "DISPUTE_LOST"].includes(String(booking.status || ""))) {
    return {
      eligible: false,
      readyAt,
      reason: "booking_blocked_by_refund_or_dispute",
    };
  }

  const blockingReports = await getBlockingReportCount(booking._id);
  if (blockingReports > 0) {
    return {
      eligible: false,
      readyAt,
      reason: "blocking_reports_open",
      blockingReports,
    };
  }

  return {
    eligible: true,
    readyAt,
    reason: "eligible",
    blockingReports: 0,
  };
};

const applyTransferReleaseState = async ({ booking, payment, decision }) => {
  if (!booking || !payment || !decision) return payment;

  payment.transferReadyAt = decision.readyAt || booking.payoutEligibleAt || null;
  payment.transferBlockedReason = decision.eligible ? "" : String(decision.reason || "");

  if (decision.eligible) {
    if (payment.transferStatus !== "TRANSFERRED") {
      payment.transferStatus = "READY";
    }
    payment.transferFailureCode = "";
    payment.transferFailureMessage = "";
  } else if (payment.transferStatus !== "TRANSFERRED") {
    payment.transferStatus = decision.reason === "cooldown_not_elapsed" ? "NOT_READY" : "BLOCKED";
  }

  await payment.save();
  return payment;
};

module.exports = {
  evaluateTransferRelease,
  applyTransferReleaseState,
};
