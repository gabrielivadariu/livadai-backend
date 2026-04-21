const stripe = require("../config/stripe");

const isSeparateChargeAndTransfer = (payment) =>
  String(payment?.chargeModel || "DESTINATION_CHARGE") === "SEPARATE_CHARGE_AND_TRANSFER";

const buildRefundParams = (payment) => {
  if (!payment) return null;
  const paymentIntentId = String(payment.stripePaymentIntentId || "").trim();
  const chargeId = String(payment.stripeChargeId || "").trim();
  if (!paymentIntentId && !chargeId) return null;

  if (isSeparateChargeAndTransfer(payment)) {
    return paymentIntentId ? { payment_intent: paymentIntentId } : { charge: chargeId };
  }

  return paymentIntentId
    ? {
        payment_intent: paymentIntentId,
        refund_application_fee: true,
        reverse_transfer: true,
      }
    : {
        charge: chargeId,
        refund_application_fee: true,
        reverse_transfer: true,
      };
};

const refundPaymentRecord = async ({ payment, bookingId = null, idempotencyKeyBase = "refund" } = {}) => {
  if (!payment) {
    return {
      attempted: false,
      refunded: false,
      refund: null,
      reversal: null,
      reversalSucceeded: false,
      reversalErrorMessage: "Missing payment",
    };
  }

  if (String(payment.status || "") === "REFUNDED") {
    return {
      attempted: false,
      refunded: true,
      refund: null,
      reversal: null,
      reversalSucceeded: true,
      reversalErrorMessage: "",
    };
  }

  const refundParams = buildRefundParams(payment);
  if (!refundParams) {
    return {
      attempted: false,
      refunded: false,
      refund: null,
      reversal: null,
      reversalSucceeded: false,
      reversalErrorMessage: "No refundable payment reference",
    };
  }

  const refund = await stripe.refunds.create(refundParams, {
    idempotencyKey: `${idempotencyKeyBase}_${payment._id}`,
  });

  let reversal = null;
  let reversalSucceeded = true;
  let reversalErrorMessage = "";

  const shouldReverseTransfer =
    isSeparateChargeAndTransfer(payment) &&
    String(payment.transferStatus || "") === "TRANSFERRED" &&
    String(payment.stripeTransferId || "").trim() &&
    !String(payment.stripeTransferReversalId || "").trim();

  if (shouldReverseTransfer) {
    const reversalAmount = Math.max(0, Number(payment.transferAmount || payment.hostNetAmount || 0));
    if (reversalAmount > 0) {
      try {
        reversal = await stripe.transfers.createReversal(payment.stripeTransferId, {
          amount: reversalAmount,
          metadata: {
            bookingId: bookingId ? String(bookingId) : "",
            paymentId: String(payment._id),
            refundId: String(refund.id || ""),
          },
        });
        payment.stripeTransferReversalId = reversal.id;
        payment.transferStatus = "REVERSED";
      } catch (err) {
        reversalSucceeded = false;
        reversalErrorMessage = String(err?.message || "Transfer reversal failed");
        payment.transferFailureCode = String(err?.code || err?.type || "");
        payment.transferFailureMessage = reversalErrorMessage;
      }
    }
  }

  payment.status = "REFUNDED";
  payment.transferBlockedReason = "";
  await payment.save();

  return {
    attempted: true,
    refunded: true,
    refund,
    reversal,
    reversalSucceeded,
    reversalErrorMessage,
  };
};

module.exports = {
  buildRefundParams,
  refundPaymentRecord,
  isSeparateChargeAndTransfer,
};
