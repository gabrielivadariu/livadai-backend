const HOST_FEE_MODES = {
  STANDARD: "STANDARD",
  HOST_PAYS_STRIPE: "HOST_PAYS_STRIPE",
};

const HOST_FEE_MODE_VALUES = Object.values(HOST_FEE_MODES);
const PLATFORM_FEE_BPS = 1000;

const normalizeMinor = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
};

const normalizeBps = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
};

const buildStripeFeeConfig = ({ percentBps, fixedMinor } = {}) => {
  const normalized = {
    percentBps: normalizeBps(percentBps),
    fixedMinor: normalizeMinor(fixedMinor),
  };
  normalized.configured =
    Number.isFinite(Number(percentBps)) &&
    Number(percentBps) >= 0 &&
    Number.isFinite(Number(fixedMinor)) &&
    Number(fixedMinor) >= 0 &&
    (normalized.percentBps > 0 || normalized.fixedMinor > 0);
  return normalized;
};

const getGlobalHostPaysStripeConfig = () =>
  buildStripeFeeConfig({
    percentBps: process.env.STRIPE_HOST_PAYS_FEE_PERCENT_BPS,
    fixedMinor: process.env.STRIPE_HOST_PAYS_FEE_FIXED_MINOR,
  });

const normalizeHostFeeMode = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  return HOST_FEE_MODE_VALUES.includes(normalized) ? normalized : HOST_FEE_MODES.STANDARD;
};

const getSavedHostStripeFeeConfig = (user = null) =>
  buildStripeFeeConfig({
    percentBps: user?.hostStripeFeePercentBps,
    fixedMinor: user?.hostStripeFeeFixedMinor,
  });

const estimateStripeFeeMinor = (amountMinor, feeConfig) => {
  const safeAmount = normalizeMinor(amountMinor);
  const config = feeConfig?.configured ? feeConfig : buildStripeFeeConfig(feeConfig);
  if (!safeAmount || !config.configured) return 0;
  const percentagePortion = Math.round((safeAmount * config.percentBps) / 10000);
  return Math.min(safeAmount, Math.max(0, percentagePortion + config.fixedMinor));
};

const calculateHostFeeBreakdown = ({
  amountMinor,
  feeMode,
  stripeFeeConfig,
  platformFeeBps = PLATFORM_FEE_BPS,
} = {}) => {
  const safeAmount = normalizeMinor(amountMinor);
  const modeApplied = normalizeHostFeeMode(feeMode);
  const normalizedPlatformFeeBps = normalizeBps(platformFeeBps);

  if (modeApplied === HOST_FEE_MODES.HOST_PAYS_STRIPE) {
    const config = stripeFeeConfig?.configured ? stripeFeeConfig : buildStripeFeeConfig(stripeFeeConfig);
    if (!config.configured) {
      return {
        modeApplied,
        errorCode: "HOST_PAYS_STRIPE_CONFIG_MISSING",
        platformFeeMinor: 0,
        transferAmountMinor: 0,
        hostNetAmountMinor: 0,
        estimatedStripeFeeMinor: 0,
      };
    }
    const estimatedStripeFeeMinor = estimateStripeFeeMinor(safeAmount, config);
    const transferAmountMinor = Math.max(0, safeAmount - estimatedStripeFeeMinor);
    if (!transferAmountMinor) {
      return {
        modeApplied,
        errorCode: "HOST_NET_AMOUNT_TOO_LOW",
        platformFeeMinor: 0,
        transferAmountMinor: 0,
        hostNetAmountMinor: 0,
        estimatedStripeFeeMinor,
      };
    }
    return {
      modeApplied,
      platformFeeMinor: 0,
      transferAmountMinor,
      hostNetAmountMinor: transferAmountMinor,
      estimatedStripeFeeMinor,
    };
  }

  const platformFeeMinor = Math.round((safeAmount * normalizedPlatformFeeBps) / 10000);
  return {
    modeApplied: HOST_FEE_MODES.STANDARD,
    platformFeeMinor,
    transferAmountMinor: safeAmount - platformFeeMinor,
    hostNetAmountMinor: Math.max(0, safeAmount - platformFeeMinor),
    estimatedStripeFeeMinor: 0,
  };
};

const buildHostFeePolicyPreview = ({ sampleAmountMinor = 100 * 100, stripeFeeConfig } = {}) => ({
  sampleAmountMinor: normalizeMinor(sampleAmountMinor),
  standard: calculateHostFeeBreakdown({
    amountMinor: sampleAmountMinor,
    feeMode: HOST_FEE_MODES.STANDARD,
  }),
  hostPaysStripe: calculateHostFeeBreakdown({
    amountMinor: sampleAmountMinor,
    feeMode: HOST_FEE_MODES.HOST_PAYS_STRIPE,
    stripeFeeConfig,
  }),
});

module.exports = {
  HOST_FEE_MODES,
  HOST_FEE_MODE_VALUES,
  PLATFORM_FEE_BPS,
  normalizeHostFeeMode,
  buildStripeFeeConfig,
  getGlobalHostPaysStripeConfig,
  getSavedHostStripeFeeConfig,
  estimateStripeFeeMinor,
  calculateHostFeeBreakdown,
  buildHostFeePolicyPreview,
};
