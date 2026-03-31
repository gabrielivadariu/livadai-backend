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
const joinName = (firstName, lastName) => [firstName, lastName].filter(Boolean).join(" ").trim();
const isSupportedExternalAccount = (item) => ["bank_account", "card"].includes(String(item?.object || ""));
const isEmailLike = (value = "") => String(value || "").includes("@");
const STRIPE_ACCESS_STATUS_INACCESSIBLE = "INACCESSIBLE";

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
  const individualName = joinName(account?.individual?.first_name, account?.individual?.last_name);
  const companyName = String(account?.company?.name || "").trim();
  if (businessType === "individual") {
    return individualName;
  }
  if (businessType === "company") {
    return companyName;
  }
  return companyName || "";
};

const getFallbackStripeDisplayName = (account) =>
  String(
    account?.business_profile?.name ||
      account?.settings?.dashboard?.display_name ||
      account?.company?.name ||
      ""
  ).trim();

const getRepresentativeNameFromStripe = async (stripeAccountId, account) => {
  const embeddedIndividualName = joinName(account?.individual?.first_name, account?.individual?.last_name);
  if (embeddedIndividualName) return embeddedIndividualName;

  const individualId = String(account?.individual?.id || "").trim();
  if (individualId) {
    try {
      const person = await stripe.accounts.retrievePerson(stripeAccountId, individualId);
      const personName = joinName(person?.first_name, person?.last_name);
      if (personName) return personName;
    } catch (_err) {
      // Some connected account types do not allow person retrieval via platform API.
    }
  }

  try {
    const persons = await stripe.accounts.listPersons(stripeAccountId, { limit: 10 });
    const rows = Array.isArray(persons?.data) ? persons.data : [];
    if (!rows.length) return "";
    const preferred =
      rows.find((row) => row?.relationship?.representative || row?.relationship?.owner || row?.relationship?.executive) || rows[0];
    return joinName(preferred?.first_name, preferred?.last_name);
  } catch (_err) {
    // Express / Standard accounts can hide persons from platform API.
    return "";
  }
};

const pickBankAccount = async (stripeAccountId, account) => {
  const defaultExternal = String(account?.default_external_account || "").trim();
  let candidates = Array.isArray(account?.external_accounts?.data)
    ? account.external_accounts.data.filter((item) => item && typeof item === "object" && isSupportedExternalAccount(item))
    : [];

  if (!candidates.length) {
    try {
      const external = await stripe.accounts.listExternalAccounts(stripeAccountId, { limit: 10 });
      candidates = Array.isArray(external?.data)
        ? external.data.filter((item) => item && typeof item === "object" && isSupportedExternalAccount(item))
        : [];
    } catch (_err) {
      candidates = [];
    }
  }

  if (!candidates.length) return null;
  let selected = defaultExternal ? candidates.find((item) => String(item?.id || "") === defaultExternal) : null;
  if (!selected) selected = candidates.find((item) => String(item?.object || "") === "bank_account");
  if (!selected) selected = candidates.find((item) => String(item?.object || "") === "card");
  if (!selected) selected = candidates[0];
  return selected || null;
};

const collectComplianceIssues = (snapshot) => {
  if (!snapshot) return ["NO_COMPLIANCE_SNAPSHOT"];
  const stripeAccessStatus = String(snapshot?.metadata?.stripeAccessStatus || "").trim().toUpperCase();
  if (stripeAccessStatus === STRIPE_ACCESS_STATUS_INACCESSIBLE || String(snapshot?.requirementsDisabledReason || "") === "STRIPE_ACCOUNT_INACCESSIBLE") {
    return ["STRIPE_ACCOUNT_INACCESSIBLE"];
  }
  const issues = [];
  if (snapshot.nameMatchState === "MISMATCH") issues.push("NAME_MISMATCH");
  if (!snapshot.stripeLegalName && !snapshot.stripeDisplayName) issues.push("STRIPE_NAME_MISSING");
  if (!snapshot.stripeLegalName && snapshot.stripeDisplayName) issues.push("STRIPE_LEGAL_NAME_MISSING");
  if (!snapshot.bankLast4) issues.push("BANK_REFERENCE_MISSING");
  if (snapshot.requirementsDisabledReason) issues.push("STRIPE_DISABLED");
  if ((snapshot.requirementsCurrentlyDue || []).length > 0) issues.push("STRIPE_REQUIREMENTS_DUE");
  if (!snapshot.isStripeDetailsSubmitted) issues.push("STRIPE_DETAILS_INCOMPLETE");
  if (!snapshot.isStripeChargesEnabled) issues.push("STRIPE_CHARGES_DISABLED");
  if (!snapshot.isStripePayoutsEnabled) issues.push("STRIPE_PAYOUTS_DISABLED");
  return issues;
};

const isStripeAccountInaccessibleError = (error) => {
  const message = String(error?.message || error || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();
  const type = String(error?.type || error?.rawType || "").toLowerCase();

  if (message.includes("does not have access to account")) return true;
  if (message.includes("application access may have been revoked")) return true;
  if (message.includes("no such account")) return true;
  if (message.includes("account does not exist")) return true;
  if (code === "resource_missing" && message.includes("account")) return true;
  if (type === "stripeinvalidrequesterror" && message.includes("account")) return true;
  return false;
};

const createHostComplianceAccessErrorSnapshot = async ({
  userId,
  stripeAccountId,
  triggerType = "manual",
  triggerEventId = "",
  triggerEventType = "",
  metadata = {},
  error = null,
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

  const livadaiName = String(user.displayName || user.display_name || user.name || "").trim();
  const livadaiEmail = String(user.email || "").trim();
  const accessErrorMessage = String(error?.message || error || "").trim();
  const accessErrorCode = String(error?.code || "").trim();
  const accessErrorType = String(error?.type || error?.rawType || "").trim();

  return HostComplianceSnapshot.create({
    user: user._id,
    stripeAccountId: accountId,
    livadaiName,
    livadaiEmail,
    stripeBusinessType: "",
    stripeLegalName: "",
    stripeDisplayName: "",
    stripeNameSource: "INACCESSIBLE",
    nameMatchState: "UNKNOWN",
    externalAccountId: "",
    bankName: "",
    bankLast4: "",
    bankCountry: DEFAULT_BANK_COUNTRY,
    bankCurrency: "",
    bankReferenceSource: "NONE",
    isStripeChargesEnabled: false,
    isStripePayoutsEnabled: false,
    isStripeDetailsSubmitted: false,
    requirementsDisabledReason: "STRIPE_ACCOUNT_INACCESSIBLE",
    requirementsCurrentlyDue: [],
    requirementsEventuallyDue: [],
    requirementsPastDue: [],
    requirementsPendingVerification: [],
    triggerType: String(triggerType || "manual"),
    triggerEventId: String(triggerEventId || ""),
    triggerEventType: String(triggerEventType || ""),
    metadata: {
      ...(metadata && typeof metadata === "object" ? metadata : {}),
      stripeAccessStatus: STRIPE_ACCESS_STATUS_INACCESSIBLE,
      stripeAccessErrorCode: accessErrorCode,
      stripeAccessErrorType: accessErrorType,
      stripeAccessErrorMessage: accessErrorMessage,
      stripeAccessDetectedAt: new Date().toISOString(),
    },
  });
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
  const representativeName = await getRepresentativeNameFromStripe(accountId, account);
  const legalName = buildStripeLegalName(account) || representativeName;
  const displayName = getFallbackStripeDisplayName(account) || legalName || String(account?.email || "").trim();
  const stripeNameSource = legalName
    ? "LEGAL_OR_REPRESENTATIVE"
    : isEmailLike(displayName)
      ? "EMAIL_FALLBACK"
      : displayName
        ? "DISPLAY_NAME"
        : "NONE";
  const businessType = String(account?.business_type || "").toLowerCase();
  const bank = await pickBankAccount(accountId, account);
  const bankObjectType = String(bank?.object || "").toLowerCase();
  const bankName =
    String(bank?.bank_name || "").trim() ||
    (bankObjectType === "card" ? `${String(bank?.brand || "Card").toUpperCase()} card` : "");
  const bankLast4 = String(bank?.last4 || "").trim();
  const bankReferenceSource = bankLast4 ? (bankObjectType === "card" ? "CARD_LAST4" : "BANK_LAST4") : "NONE";

  const livadaiName = String(user.displayName || user.display_name || user.name || "").trim();
  const nameForMatch = legalName || (isEmailLike(displayName) ? "" : displayName);
  const matchState = detectNameMatchState(livadaiName, nameForMatch);

  const snapshot = await HostComplianceSnapshot.create({
    user: user._id,
    stripeAccountId: accountId,
    livadaiName,
    livadaiEmail: String(user.email || "").trim(),
    stripeBusinessType: businessType,
    stripeLegalName: legalName,
    stripeDisplayName: displayName,
    stripeNameSource,
    nameMatchState: matchState,
    externalAccountId: String(bank?.id || ""),
    bankName,
    bankLast4,
    bankCountry: String(bank?.country || DEFAULT_BANK_COUNTRY),
    bankCurrency: String(bank?.currency || account?.default_currency || ""),
    bankReferenceSource,
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
  isStripeAccountInaccessibleError,
  createHostComplianceAccessErrorSnapshot,
};
