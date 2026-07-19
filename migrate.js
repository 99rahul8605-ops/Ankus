#!/usr/bin/env node
/**
 * migrate.js — StuBot One-Time Migration Helper
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this ONCE after deploying if you are migrating from a previous bot that
 * used SQLite + MongoDB dual-storage (Bot 1 / EduBot).
 *
 * What it does:
 *   1. Ensures all required MongoDB indexes exist.
 *   2. Cleans up any stale SQLite-only data references (none, since SQLite was
 *      removed — but we verify MongoDB collections are reachable).
 *   3. Seeds a default ReferralPremium periodStart for existing users (so their
 *      referral count starts fresh from today, not from epoch).
 *   4. Drops old TTL index on FileRecord.expires_at (if present from old build).
 *   5. Prints a summary.
 *
 * Usage:
 *   MONGO_URI="mongodb+srv://..." node migrate.js
 *
 * Safe to run multiple times (idempotent).
 */

require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("❌  MONGO_URI env var is required.");
  process.exit(1);
}

async function run() {
  console.log("🔌  Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅  Connected.\n");

  const db   = mongoose.connection;
  const cols  = await db.db.listCollections().toArray();
  const names = cols.map(c => c.name);
  console.log(`📋  Existing collections (${names.length}): ${names.join(", ") || "none"}\n`);

  // ── 1. Drop stale TTL index on filerecords.expires_at ────────────────────
  if (names.includes("filerecords")) {
    try {
      await db.collection("filerecords").dropIndex("expires_at_1");
      console.log("🗑️   Dropped stale TTL index 'expires_at_1' on filerecords.");
    } catch (e) {
      if (e.codeName === "IndexNotFound") {
        console.log("✔️   No stale TTL index on filerecords (already clean).");
      } else {
        console.warn("⚠️   dropIndex(expires_at_1):", e.message);
      }
    }
  } else {
    console.log("ℹ️   filerecords collection does not exist yet (will be created on first upload).");
  }

  // ── 2. Ensure critical indexes are present ────────────────────────────────
  console.log("\n🔧  Ensuring indexes...");

  // referrals
  if (names.includes("referrals")) {
    await db.collection("referrals").createIndex({ referrerId: 1 });
    await db.collection("referrals").createIndex({ referredId: 1 }, { unique: true });
    console.log("   referrals: indexes ok.");
  }

  // referralpremiums
  if (names.includes("referralpremiums")) {
    await db.collection("referralpremiums").createIndex({ userId: 1 }, { unique: true });
    console.log("   referralpremiums: indexes ok.");
  }

  // watchedlectures
  if (names.includes("watchedlectures")) {
    await db.collection("watchedlectures").createIndex({ userId: 1, watchDay: 1 }, { unique: true });
    console.log("   watchedlectures: indexes ok.");
  }

  // ── 3. Seed ReferralPremium periodStart for existing users ────────────────
  // If any old referrals exist and ReferralPremium docs don't have a proper periodStart,
  // set periodStart = NOW so the new premium cycle starts fresh (they won't get
  // backdated referrals counted toward the new system).
  console.log("\n🌱  Seeding ReferralPremium periodStart for existing referrers...");

  if (names.includes("referrals")) {
    const existingReferrers = await db.collection("referrals").distinct("referrerId");
    let seeded = 0;
    const now  = new Date();

    for (const referrerId of existingReferrers) {
      const existing = await db.collection("referralpremiums").findOne({ userId: referrerId });
      if (!existing) {
        await db.collection("referralpremiums").insertOne({
          userId:      referrerId,
          unlockedAt:  null,
          expiresAt:   null,
          periodStart: now,
        });
        seeded++;
      } else if (!existing.periodStart || existing.periodStart.getTime() === 0) {
        await db.collection("referralpremiums").updateOne(
          { userId: referrerId },
          { $set: { periodStart: now } }
        );
        seeded++;
      }
    }
    console.log(`   Seeded/updated periodStart for ${seeded} referrer(s) out of ${existingReferrers.length} total.`);
  } else {
    console.log("   No referrals collection found — nothing to seed.");
  }

  // ── 4. Verify key collections are reachable ───────────────────────────────
  console.log("\n🔍  Collection health check:");
  const toCheck = [
    { name: "batches",          label: "Batches (courses)" },
    { name: "filerecords",      label: "File Store"        },
    { name: "bulkbatches",      label: "Bulk Batches"      },
    { name: "accesses",         label: "Timed Access"      },
    { name: "referrals",        label: "Referrals"         },
    { name: "referralpremiums", label: "Referral Premium"  },
    { name: "users",            label: "Users"             },
    { name: "admins",           label: "Admins"            },
    { name: "watchedlectures",  label: "Daily Limits"      },
    { name: "spinhistories",    label: "Spin History"      },
    { name: "rewardredemptions",label: "Reward Redemptions"},
  ];
  for (const { name, label } of toCheck) {
    if (names.includes(name)) {
      const count = await db.collection(name).estimatedDocumentCount();
      console.log(`   ✅  ${label}: ${count} document(s)`);
    } else {
      console.log(`   ⬜  ${label}: (not created yet)`);
    }
  }

  // ── 5. Remove old payment-related collections (if they exist from EduBot) ─
  const payCollections = ["paymentrequests", "pendingpayments", "coupons"];
  console.log("\n🧹  Checking for legacy payment collections...");
  for (const col of payCollections) {
    if (names.includes(col)) {
      const count = await db.collection(col).estimatedDocumentCount();
      console.log(`   ⚠️   Found legacy collection '${col}' with ${count} docs.`);
      console.log(`         To drop it: db.${col}.drop() in MongoDB Shell (manual step — skipped for safety).`);
    }
  }

  console.log("\n✅  Migration complete! StuBot is ready.\n");
  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error("❌  Migration failed:", err);
  process.exit(1);
});
