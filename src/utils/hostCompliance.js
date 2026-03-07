const stripe = require("../config/stripe");
const User = require("../models/user.model");
const HostComplianceSnapshot = require("../models/hostComplianceSnapshot.model");

const DEFAULT_BANK_COUNTRY = "RO";

const normalizeName = (value = "") =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const cleanStringList = (value) => (Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : []);

const detectNameMatchState = (livadaiName, stripeLegalName) => {
  const local = normalizeName(livadaiName);
  const stripeName = normalizeName(stripeLegalName);
  if (!local && !stripeName) return "UNKNOWN";
  if (!stripeName) return "MISSING_STRIPE_NAME";
  if (!local) return "MISSING_LIVADAI_NAME";
  if (local === stripeName || local.includes(stripeName) || stripeName.includes(local)) return "MATCH";

  const left = new Set(local.split(" ").filter(Boolean));
  const right = new Set(stripeName.split(" ").filter(Boolean));
  const common = [...left].filter((token) => right.has(token)).length;
  const threshold = Math.max(1, Math.min(2, Math.min(left.size, right.size)));
  return common >= threshold ? "MATCH" : "MISMATCH";
};

const buildStripeLegalName = (account) => {
  const businessType = String(account?.business_type || "").toLowerCase();
  const individualName = [account?.individual?.first_name, account?.individual?.last_name].filter(Boolean).join(" ").trim();
  const companyName = String(account?.company?.name || "").trim();
  if (businessType === "individual") {
    return individualName;
  }
  if (businessType === "company") {
    return companyName;
  }
  return companyName || individualName || "";
};

const getFallbackStripeName = (account) =>
  String(
    account?.business_profile?.name ||
      account?.settings?.dashboard?.display_name ||
      account?.company?.name ||
      account?.email ||
      ""
  ).trim();

const pickBankAccount = async (stripeAccountId, account) => {
  const defaultExternal = String(account?.default_external_account || "").trim();
  let candidates = Array.isArray(account?.external_accounts?.data)
    ? account.external_accounts.data.filter((item) => item && typeof item === "object")
    : [];

  if (!candidates.length) {
    try {
      const external = await stripe.accounts.listExternalAccounts(stripeAccountId, {
        object: "bank_account",
        limit: 10,
      });
      candidates = Array.isArray(external?.data) ? external.data.filter((item) => item && typeof item === "object") : [];
    } catch (_err) {
      candidates = [];
    }
  }

  if (!candidates.length) return null;
  let selected = defaultExternal ? candidates.find((item) => String(item?.id || "") === defaultExternal) : null;
  if (!selected) selected = candidates.find((item) => String(item?.object || "") === "bank_account");
  if (!selected) selected = candidates[0];
  return selected || null;
};

const collectComplianceIssues = (snapshot) => {
  if (!snapshot) return ["NO_COMPLIANCE_SNAPSHOT"];
  const issues = [];
  if (snapshot.nameMatchState === "MISMATCH") issues.push("NAME_MISMATCH");
  if (snapshot.nameMatchState === "MISSING_STRIPE_NAME") issues.push("STRIPE_NAME_MISSING");
  if (!snapshot.bankLast4) issues.push("BANK_REFERENCE_MISSING");
  if (snapshot.requirementsDisabledReason) issues.push("STRIPE_DISABLED");
  if ((snapshot.requirementsCurrentlyDue || []).length > 0) issues.push("STRIPE_REQUIREMENTS_DUE");
  if (!snapshot.isStripeDetailsSubmitted) issues.push("STRIPE_DETAILS_INCOMPLETE");
  if (!snapshot.isStripeChargesEnabled) issues.push("STRIPE_CHARGES_DISABLED");
  if (!snapshot.isStripePayoutsEnabled) issues.push("STRIPE_PAYOUTS_DISABLED");
  return issues;
};

const syncHostComplianceSnapshot = async ({
  userId,
  stripeAccountId,
  triggerType = "manual",
  triggerEventId = "",
  triggerEventType = "",
  metadata = {},
} = {}) => {
  const query = userId ? { _id: userId } : stripeAccountId ? { stripeAccountId } : null;
  if (!query) return null;

  const user = await User.findOne(query).select(
    "name displayName display_name email role stripeAccountId isStripeChargesEnabled isStripePayoutsEnabled isStripeDetailsSubmitted"
  );
  if (!user) return null;

  const role = String(user.role || "").toUpperCase();
  if (!["HOST", "BOTH"].includes(role)) return null;

  const accountId = String(stripeAccountId || user.stripeAccountId || "").trim();
  if (!accountId) return null;

  const account = await stripe.accounts.retrieve(accountId);
  const legalName = buildStripeLegalName(account) || getFallbackStripeName(account);
  const displayName = getFallbackStripeName(account);
  const businessType = String(account?.business_type || "").toLowerCase();
  const bank = await pickBankAccount(accountId, account);

  const livadaiName = String(user.displayName || user.display_name || user.name || "").trim();
  const matchState = detectNameMatchState(livadaiName, legalName);

  const snapshot = await HostComplianceSnapshot.create({
    user: user._id,
    stripeAccountId: accountId,
    livadaiName,
    livadaiEmail: String(user.email || "").trim(),
    stripeBusinessType: businessType,
    stripeLegalName: legalName,
    stripeDisplayName: displayName,
    nameMatchState: matchState,
    externalAccountId: String(bank?.id || ""),
    bankName: String(bank?.bank_name || ""),
    bankLast4: String(bank?.last4 || ""),
    bankCountry: String(bank?.country || DEFAULT_BANK_COUNTRY),
    bankCurrency: String(bank?.currency || account?.default_currency || ""),
    isStripeChargesEnabled: !!account?.charges_enabled,
    isStripePayoutsEnabled: !!account?.payouts_enabled,
    isStripeDetailsSubmitted: !!account?.details_submitted,
    requirementsDisabledReason: String(account?.requirements?.disabled_reason || ""),
    requirementsCurrentlyDue: cleanStringList(account?.requirements?.currently_due),
    requirementsEventuallyDue: cleanStringList(account?.requirements?.eventually_due),
    requirementsPastDue: cleanStringList(account?.requirements?.past_due),
    requirementsPendingVerification: cleanStringList(account?.requirements?.pending_verification),
    triggerType: String(triggerType || "manual"),
    triggerEventId: String(triggerEventId || ""),
    triggerEventType: String(triggerEventType || ""),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  });

  return snapshot;
};

module.exports = {
  syncHostComplianceSnapshot,
  collectComplianceIssues,
};
