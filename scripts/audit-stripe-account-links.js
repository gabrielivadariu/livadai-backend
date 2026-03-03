require("dotenv").config();
const mongoose = require("mongoose");
const stripe = require("../src/config/stripe");
const User = require("../src/models/user.model");

const run = async () => {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("Missing MONGO_URI (or MONGODB_URI) in environment.");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);

  const users = await User.find({
    stripeAccountId: { $nin: [null, ""] },
  }).select("_id email role stripeAccountId");

  const byAccount = new Map();
  for (const user of users) {
    const key = String(user.stripeAccountId || "").trim();
    if (!key) continue;
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key).push(user);
  }

  const duplicates = [...byAccount.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([stripeAccountId, rows]) => ({
      stripeAccountId,
      users: rows.map((row) => ({
        id: String(row._id),
        email: row.email || "",
        role: row.role || "",
      })),
    }));

  const metadataMismatches = [];
  const missingMetadata = [];
  const retrieveErrors = [];

  for (const user of users) {
    const accountId = String(user.stripeAccountId || "").trim();
    if (!accountId) continue;
    try {
      const acct = await stripe.accounts.retrieve(accountId);
      const ownerId = String(acct?.metadata?.livadaiUserId || "").trim();
      const ownerEmail = String(acct?.metadata?.livadaiUserEmail || "").trim();
      if (!ownerId) {
        missingMetadata.push({
          userId: String(user._id),
          email: user.email || "",
          stripeAccountId: accountId,
          ownerEmail,
        });
      } else if (ownerId !== String(user._id)) {
        metadataMismatches.push({
          userId: String(user._id),
          email: user.email || "",
          stripeAccountId: accountId,
          metadataUserId: ownerId,
          metadataUserEmail: ownerEmail,
        });
      }
    } catch (err) {
      retrieveErrors.push({
        userId: String(user._id),
        email: user.email || "",
        stripeAccountId: accountId,
        error: err?.message || String(err),
      });
    }
  }

  const summary = {
    totalLinkedUsers: users.length,
    duplicateStripeAccountIds: duplicates.length,
    metadataMismatches: metadataMismatches.length,
    missingMetadata: missingMetadata.length,
    stripeRetrieveErrors: retrieveErrors.length,
  };

  console.log("Stripe link audit summary:", summary);
  if (duplicates.length) console.log("Duplicates:", JSON.stringify(duplicates, null, 2));
  if (metadataMismatches.length) console.log("Metadata mismatches:", JSON.stringify(metadataMismatches, null, 2));
  if (missingMetadata.length) console.log("Missing metadata:", JSON.stringify(missingMetadata, null, 2));
  if (retrieveErrors.length) console.log("Stripe retrieve errors:", JSON.stringify(retrieveErrors, null, 2));

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error("Stripe link audit script failed:", err);
  process.exit(1);
});
