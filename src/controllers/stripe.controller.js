const stripe = require("../config/stripe");
const User = require("../models/user.model");
const Transaction = require("../models/transaction.model");
const { isPayoutEligible, logPayoutAttempt } = require("../utils/payout");

const REFRESH_URL = process.env.FRONTEND_REFRESH_URL || "http://localhost:3000/stripe/refresh";
const RETURN_URL = process.env.FRONTEND_RETURN_URL || "http://localhost:3000/stripe/success";
const PLATFORM_FEE = 0.1; // 10%

// Create/connect host account and return onboarding link
const createHostAccount = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    let accountId = user.stripeAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: user.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
      });
      accountId = account.id;
      user.stripeAccountId = accountId;
      user.isStripeChargesEnabled = false;
      user.isStripePayoutsEnabled = false;
      user.isStripeDetailsSubmitted = false;
      await user.save();
    }

    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: REFRESH_URL,
      return_url: RETURN_URL,
      type: "account_onboarding",
    });

    return res.json({ url: accountLink.url, stripeAccountId: accountId });
  } catch (err) {
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
    const platformFee = Math.round(amountMinor * PLATFORM_FEE);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency: "ron",
      automatic_payment_methods: { enabled: true },
      transfer_data: { destination: host.stripeAccountId },
      application_fee_amount: platformFee,
      metadata: {
        hostId: hostId.toString(),
        clientId: req.user.id,
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
