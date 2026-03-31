const stripe = require("../config/stripe");
const User = require("../models/user.model");
const Transaction = require("../models/transaction.model");
const { isPayoutEligible, logPayoutAttempt } = require("../utils/payout");
const { syncHostComplianceSnapshot } = require("../utils/hostCompliance");
const { HOST_FEE_MODES, calculateHostFeeBreakdown, getSavedHostStripeFeeConfig, normalizeHostFeeMode } = require("../utils/hostFeePolicy");

const REFRESH_URL = process.env.FRONTEND_REFRESH_URL || "http://localhost:3000/stripe/refresh";
const RETURN_URL = process.env.FRONTEND_RETURN_URL || "http://localhost:3000/stripe/success";
const ensureStripeAccountUniqueness = async (accountId, userId) => {
  const existing = await User.findOne({
    stripeAccountId: String(accountId || "").trim(),
    _id: { $ne: userId },
  }).select("_id email");
  if (existing) {
    const err = new Error("Stripe account already linked to another LIVADAI user");
    err.code = "STRIPE_ACCOUNT_ALREADY_LINKED";
    err.status = 409;
    throw err;
  }
};

const ensureStripeMetadataOwnership = async (accountId, user) => {
  const acct = await stripe.accounts.retrieve(accountId);
  const metadata = acct?.metadata && typeof acct.metadata === "object" ? acct.metadata : {};
  const ownerId = String(metadata.livadaiUserId || "").trim();
  if (ownerId && ownerId !== String(user._id)) {
    const err = new Error("Stripe account metadata owner mismatch");
    err.code = "STRIPE_METADATA_OWNER_MISMATCH";
    err.status = 409;
    throw err;
  }

  const nextMetadata = {
    ...metadata,
    livadaiUserId: String(user._id),
    livadaiUserEmail: String(user.email || "").trim(),
  };
  await stripe.accounts.update(accountId, { metadata: nextMetadata });
};

const listAllConnectedAccounts = async ({ maxPages = 20, limit = 100 } = {}) => {
  const rows = [];
  let startingAfter = "";
  let hasMore = true;
  let pageNo = 0;

  while (hasMore && pageNo < maxPages) {
    const page = await stripe.accounts.list({
      limit,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    const data = Array.isArray(page?.data) ? page.data : [];
    if (!data.length) break;
    rows.push(...data);
    hasMore = !!page?.has_more;
    startingAfter = String(data[data.length - 1]?.id || "");
    pageNo += 1;
  }

  return rows;
};

const scoreAccountCandidate = (account, userId) => {
  const metadata = account?.metadata && typeof account.metadata === "object" ? account.metadata : {};
  const ownerId = String(metadata.livadaiUserId || "").trim();
  if (!ownerId) return -1;
  if (ownerId !== String(userId)) return -1;

  let score = 0;
  score += 100;
  if (account?.details_submitted) score += 25;
  if (account?.charges_enabled) score += 20;
  if (account?.payouts_enabled) score += 20;
  if (String(account?.type || "").toLowerCase() === "express") score += 10;
  return score;
};

const findReusableStripeAccountForUser = async (user) => {
  const connectedAccounts = await listAllConnectedAccounts();
  if (!connectedAccounts.length) return null;

  const candidates = connectedAccounts
    .map((account) => ({
      account,
      score: scoreAccountCandidate(account, user?._id),
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const bCreated = Number(b.account?.created || 0);
      const aCreated = Number(a.account?.created || 0);
      return bCreated - aCreated;
    });

  for (const row of candidates) {
    const accountId = String(row.account?.id || "").trim();
    if (!accountId) continue;
    try {
      await ensureStripeAccountUniqueness(accountId, user._id);
      return {
        accountId,
        source: "metadata_owner",
      };
    } catch (err) {
      if (err?.code === "STRIPE_ACCOUNT_ALREADY_LINKED") {
        continue;
      }
      throw err;
    }
  }

  return null;
};

// Create/connect host account and return onboarding link
const createHostAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const hostMetadata = {
      livadaiUserId: String(user._id),
      livadaiUserEmail: String(user.email || "").trim(),
    };
    let accountId = user.stripeAccountId;
    let triggerType = "host_account_link_opened";
    if (!accountId) {
      const reusable = await findReusableStripeAccountForUser(user);
      if (reusable?.accountId) {
        accountId = reusable.accountId;
        triggerType = `host_account_reused_${reusable.source}`;
      } else {
        const account = await stripe.accounts.create({
          type: "express",
          email: user.email,
          metadata: hostMetadata,
          capabilities: {
            card_payments: { requested: true },
            transfers: { requested: true },
          },
        });
        accountId = account.id;
        triggerType = "host_account_created";
      }

      await ensureStripeAccountUniqueness(accountId, user._id);
      await User.findByIdAndUpdate(user._id, { stripeAccountId: accountId }, { new: false });
    } else {
      await ensureStripeAccountUniqueness(accountId, user._id);
    }

    await ensureStripeMetadataOwnership(accountId, user);

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: REFRESH_URL,
      return_url: RETURN_URL,
      type: "account_onboarding",
    });

    try {
      await syncHostComplianceSnapshot({
        userId: user._id,
        stripeAccountId: accountId,
        triggerType,
        metadata: { source: "createHostAccount" },
      });
    } catch (err) {
      console.error("Host compliance snapshot sync error", err?.message || err);
    }

    return res.json({ url: accountLink.url, stripeAccountId: accountId });
  } catch (err) {
    if (err?.status) {
      return res.status(err.status).json({ code: err.code || "STRIPE_LINK_ERROR", message: err.message || "Stripe link error" });
    }
    console.error("Create host account error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Dashboard login link for host
const hostDashboardLink = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.stripeAccountId) return res.status(400).json({ message: "Stripe account not found" });
    const link = await stripe.accounts.createLoginLink(user.stripeAccountId);
    return res.json({ url: link.url });
  } catch (err) {
    console.error("Host dashboard link error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Payment intent for client paying host (destination charges)
const createCheckout = async (req, res) => {
  try {
    const { hostId, amount } = req.body;
    if (!hostId || !amount) return res.status(400).json({ message: "hostId and amount required" });
    const host = await User.findById(hostId);
    if (!host || host.role !== "HOST") return res.status(404).json({ message: "Host not found" });
    if (!host.stripeAccountId || !host.isStripeChargesEnabled) {
      return res.status(400).json({ message: "Host is not ready to accept payments" });
    }

    const amountMinor = Math.round(Number(amount));
    if (amountMinor <= 0) return res.status(400).json({ message: "Invalid amount" });
    const paymentSplit = calculateHostFeeBreakdown({
      amountMinor,
      feeMode: normalizeHostFeeMode(host.hostFeeMode),
      stripeFeeConfig: getSavedHostStripeFeeConfig(host),
    });

    if (paymentSplit.errorCode === "HOST_PAYS_STRIPE_CONFIG_MISSING") {
      return res.status(503).json({ message: "Host fee policy is not configured correctly. Please contact support." });
    }
    if (paymentSplit.errorCode === "HOST_NET_AMOUNT_TOO_LOW") {
      return res.status(400).json({ message: "Amount is too low for the selected host fee policy." });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency: "ron",
      automatic_payment_methods: { enabled: true },
      transfer_data:
        paymentSplit.modeApplied === HOST_FEE_MODES.HOST_PAYS_STRIPE
          ? { destination: host.stripeAccountId, amount: paymentSplit.transferAmountMinor }
          : { destination: host.stripeAccountId },
      ...(paymentSplit.modeApplied === HOST_FEE_MODES.STANDARD && paymentSplit.platformFeeMinor > 0
        ? { application_fee_amount: paymentSplit.platformFeeMinor }
        : {}),
      metadata: {
        hostId: hostId.toString(),
        clientId: req.user.id,
        hostFeeMode: paymentSplit.modeApplied,
        platformFeeMinor: String(paymentSplit.platformFeeMinor || 0),
        estimatedStripeFeeMinor: String(paymentSplit.estimatedStripeFeeMinor || 0),
        hostNetAmountMinor: String(paymentSplit.hostNetAmountMinor || 0),
      },
    });

    return res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Create checkout (PI) error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Wallet balance for host
const walletBalance = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.stripeAccountId) {
        return res.status(400).json({ code: "STRIPE_NOT_CONNECTED", message: "Stripe account not connected" });
    }
    if (!user.isStripeChargesEnabled) {
        return res.status(400).json({ code: "STRIPE_NOT_READY", message: "Stripe account not ready" });
    }
    const balance = await stripe.balance.retrieve({ stripeAccount: user.stripeAccountId });
    const available = (balance.available || []).filter((b) => b.currency === "ron").reduce((s, b) => s + b.amount, 0);
    const pending = (balance.pending || []).filter((b) => b.currency === "ron").reduce((s, b) => s + b.amount, 0);
    return res.json({ available, pending, currency: "ron" });
  } catch (err) {
    console.error("Wallet balance error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Wallet transactions for host (from local DB)
const walletTransactions = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user?.stripeAccountId) {
      return res.status(400).json({ code: "STRIPE_NOT_CONNECTED", message: "Stripe account not connected" });
    }
    if (!user.isStripeChargesEnabled) {
      return res.status(400).json({ code: "STRIPE_NOT_READY", message: "Stripe account not ready" });
    }
    const txs = await Transaction.find({ user: req.user.id }).sort({ createdAt: -1 }).limit(50);
    return res.json(txs);
  } catch (err) {
    console.error("Wallet transactions error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Debug endpoint to inspect host Stripe status
const debugHostStatus = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  const summary = {
    stripeAccountId: user.stripeAccountId || null,
    isStripeChargesEnabled: !!user.isStripeChargesEnabled,
    isStripePayoutsEnabled: !!user.isStripePayoutsEnabled,
    isStripeDetailsSubmitted: !!user.isStripeDetailsSubmitted,
  };
  if (user.stripeAccountId) {
    try {
      const acct = await stripe.accounts.retrieve(user.stripeAccountId);
      summary.charges_enabled = !!acct?.charges_enabled;
      summary.payouts_enabled = !!acct?.payouts_enabled;
      summary.details_submitted = !!acct?.details_submitted;
    } catch (err) {
      console.error("Debug host status: cannot retrieve account", err?.message || err);
    }
  }
  return res.json(summary);
};

// Create onboarding link for existing Stripe account
const createOnboardingLink = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.stripeAccountId) {
      return res.status(400).json({ message: "Stripe account not connected" });
    }
    const accountLink = await stripe.accountLinks.create({
      account: user.stripeAccountId,
      refresh_url: REFRESH_URL,
      return_url: RETURN_URL,
      type: "account_onboarding",
    });
    return res.json({ url: accountLink.url, stripeAccountId: user.stripeAccountId });
  } catch (err) {
    console.error("Create onboarding link error", err);
    return res.status(500).json({ message: "Server error" });
  }
};

module.exports = {
  createHostAccount,
  createOnboardingLink,
  hostDashboardLink,
  createCheckout,
  walletBalance,
  walletTransactions,
  debugHostStatus,
};
