"use strict";
/**
 * routes/course.js — StuBot API Routes
 * ────────────────────────────────────────────────────────────────────────────
 * All data lives in MongoDB (no SQLite).
 * Exports: router, autoLectureSession, autoAddLecture
 */

const express  = require("express");
const router   = express.Router();
const crypto   = require("crypto");
const mongoose = require("mongoose");
const Batch    = require("../models/Course");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID  = parseInt(process.env.OWNER_ID || "0");
const PREMIUM_REFERRAL_COUNT = parseInt(process.env.PREMIUM_REFERRAL_COUNT || "5");
const PREMIUM_DAYS           = parseInt(process.env.PREMIUM_DAYS || "7");

// ── Utility ───────────────────────────────────────────────────────────────────
function getTodayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

// Ad-watch tokens (one-time, 10 min TTL)
const adTokenSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  token:     { type: String, required: true, unique: true },
  issuedAt:  { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});
adTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const AdToken = mongoose.models.AdToken || mongoose.model("AdToken", adTokenSchema);

// Timed access (earned by watching ads)
const accessSchema = new mongoose.Schema({
  userId:      { type: String, required: true, unique: true },
  expiresAt:   { type: Date,   required: true },
  claimsToday: { type: Number, default: 0 },
  claimDay:    { type: String, default: "" }, // 'YYYY-MM-DD' IST
});
const Access = mongoose.models.Access || mongoose.model("Access", accessSchema);

// Referral records (one entry per referred user, unique on referredId)
const referralSchema = new mongoose.Schema({
  referrerId:    { type: String, required: true },
  referredId:    { type: String, required: true },
  forceVerified: { type: Boolean, default: false }, // true once referred user completes force-join
  createdAt:     { type: Date, default: Date.now },
});
referralSchema.index({ referrerId: 1 });
referralSchema.index({ referredId: 1 }, { unique: true });
const Referral = mongoose.models.Referral || mongoose.model("Referral", referralSchema);

// ── Referral Premium ──────────────────────────────────────────────────────────
// Tracks the referral-based 7-day premium unlock for each user.
// periodStart = when this unlock cycle began (referrals made before this don't count).
// After premium expires, a new doc is created with a fresh periodStart.
const referralPremiumSchema = new mongoose.Schema({
  userId:      { type: String, required: true, unique: true },
  unlockedAt:  { type: Date, default: null },   // null = not yet unlocked this cycle
  expiresAt:   { type: Date, default: null },   // null = not active
  periodStart: { type: Date, default: Date.now }, // count refs from here
});
const ReferralPremium = mongoose.models.ReferralPremium || mongoose.model("ReferralPremium", referralPremiumSchema);

// Points-based reward redemptions
const rewardRedemptionSchema = new mongoose.Schema({
  userId:     { type: String, required: true },
  rewardType: { type: String, required: true }, // 'accessPass' | 'batch24h' | 'batch7d'
  batchId:    { type: String, default: null },
  batchName:  { type: String, default: "" },
  pointsCost: { type: Number, required: true },
  redeemedAt: { type: Date, default: Date.now },
  expiresAt:  { type: Date, required: true },
});
rewardRedemptionSchema.index({ userId: 1 });
const RewardRedemption = mongoose.models.RewardRedemption || mongoose.model("RewardRedemption", rewardRedemptionSchema);

// Batch reward access (granted by redeeming points)
const batchRewardAccessSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  batchId:   { type: String, required: true },
  batchName: { type: String, default: "" },
  expiresAt: { type: Date, required: true },
  grantedAt: { type: Date, default: Date.now },
});
batchRewardAccessSchema.index({ userId: 1, batchId: 1 }, { unique: true });
const BatchRewardAccess = mongoose.models.BatchRewardAccess || mongoose.model("BatchRewardAccess", batchRewardAccessSchema);

// Spin tokens (one per spin session)
const spinTokenSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  token:     { type: String, required: true, unique: true },
  issuedAt:  { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});
spinTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const SpinToken = mongoose.models.SpinToken || mongoose.model("SpinToken", spinTokenSchema);

// Spin history (daily spins log)
const spinHistorySchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  pointsWon: { type: Number, required: true },
  spinDay:   { type: String, required: true }, // 'YYYY-MM-DD' IST
  spunAt:    { type: Date, default: Date.now },
});
spinHistorySchema.index({ userId: 1, spinDay: 1 });
const SpinHistory = mongoose.models.SpinHistory || mongoose.model("SpinHistory", spinHistorySchema);

// Watched lectures (for daily video limit tracking)
const watchedLectureSchema = new mongoose.Schema({
  userId:    { type: Number, required: true },
  watchDay:  { type: String, required: true }, // 'YYYY-MM-DD' IST
  count:     { type: Number, default: 0 },
});
watchedLectureSchema.index({ userId: 1, watchDay: 1 }, { unique: true });
const WatchedLecture = mongoose.models.WatchedLecture || mongoose.model("WatchedLecture", watchedLectureSchema);

// ── Auto Lecture Session (green-tick bot feature) ─────────────────────────────
const autoLecSessionSchema = new mongoose.Schema({
  _id:          { type: String, default: "singleton" },
  active:       { type: Boolean, default: false },
  batchId:      { type: String,  default: null },
  subjectId:    { type: String,  default: null },
  chapterId:    { type: String,  default: null },
  unitId:       { type: String,  default: null },
  lectureCount: { type: Number,  default: 0 },
  batchName:    { type: String,  default: "" },
  subjectName:  { type: String,  default: "" },
  chapterName:  { type: String,  default: "" },
  unitName:     { type: String,  default: "" },
}, { _id: false });
const AutoLecSession = mongoose.models.AutoLecSession || mongoose.model("AutoLecSession", autoLecSessionSchema);

// In-memory mirror — synced on startup and on every write
const autoLectureSession = {
  active: false,
  batchId: null, subjectId: null, chapterId: null, unitId: null,
  lectureCount: 0,
  batchName: "", subjectName: "", chapterName: "", unitName: "",
};

(async () => {
  try {
    // Wait for mongoose to be ready before querying
    if (mongoose.connection.readyState !== 1) {
      mongoose.connection.once("connected", async () => {
        const doc = await AutoLecSession.findById("singleton").catch(() => null);
        if (doc) Object.assign(autoLectureSession, doc.toObject());
      });
    } else {
      const doc = await AutoLecSession.findById("singleton").catch(() => null);
      if (doc) Object.assign(autoLectureSession, doc.toObject());
    }
  } catch (e) { /* non-fatal */ }
})();

async function _saveAutoSession() {
  try {
    await AutoLecSession.findByIdAndUpdate(
      "singleton", { $set: autoLectureSession }, { upsert: true, new: true }
    );
  } catch (e) { /* non-fatal */ }
}

async function autoAddLecture({ batchId, subjectId, chapterId, unitId, name, link }) {
  const batch = await Batch.findById(batchId);
  if (!batch) throw new Error("Batch not found");
  const subj  = batch.subjects.id(subjectId);
  if (!subj)  throw new Error("Subject not found");
  const chap  = subj.chapters.id(chapterId);
  if (!chap)  throw new Error("Chapter not found");
  if (unitId) {
    const unit = chap.units.id(unitId);
    if (!unit) throw new Error("Unit not found");
    unit.lectures.push({ name, link, notes: "", order: unit.lectures.length });
  } else {
    chap.lectures.push({ name, link, notes: "", order: chap.lectures.length });
  }
  await batch.save();
}

// ── Admin auth helpers ────────────────────────────────────────────────────────
function verifyAdmin(req, res, next) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return res.status(401).json({ error: "Unauthorized" });
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataStr = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret  = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expected = crypto.createHmac("sha256", secret).update(dataStr).digest("hex");
    if (expected !== hash) return res.status(401).json({ error: "Invalid signature" });
    const user = JSON.parse(params.get("user") || "{}");
    if (user.id !== OWNER_ID) return res.status(403).json({ error: "Forbidden" });
    next();
  } catch (e) { res.status(401).json({ error: "Verification failed" }); }
}

function isAdminRequest(req) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return false;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataStr = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret  = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expected = crypto.createHmac("sha256", secret).update(dataStr).digest("hex");
    if (expected !== hash) return false;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id === OWNER_ID;
  } catch { return false; }
}

function getRequestUserId(req) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const dataStr = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret  = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expected = crypto.createHmac("sha256", secret).update(dataStr).digest("hex");
    if (expected !== hash) return null;
    const user = JSON.parse(params.get("user") || "{}");
    return user.id ? String(user.id) : null;
  } catch { return null; }
}

// ── Premium access helpers ────────────────────────────────────────────────────
// Returns true when a user can view a premium batch's content.
// Checks: permanent access (premiumUsers list) OR reward-batch access OR referral premium.
async function hasPremiumAccess(userId, batch) {
  const uid = String(userId);
  // 1. Admin always has access
  if (String(OWNER_ID) === uid) return true;
  // 2. Permanent access list on batch
  if (batch.premiumUsers && batch.premiumUsers.includes(uid)) return true;

  const now = new Date();

  // 3. Points-redeemed batch reward access
  try {
    const bra = await BatchRewardAccess.findOne({ userId: uid, batchId: String(batch._id) });
    if (bra && bra.expiresAt > now) return true;
  } catch { /* non-fatal */ }

  // 4. Points-redeemed general access pass
  try {
    const redemption = await RewardRedemption.findOne({
      userId: uid, rewardType: "accessPass", expiresAt: { $gt: now }
    });
    if (redemption) return true;
  } catch { /* non-fatal */ }

  // 5. Referral premium unlock
  try {
    const rp = await ReferralPremium.findOne({ userId: uid });
    if (rp && rp.expiresAt && rp.expiresAt > now) return true;
  } catch { /* non-fatal */ }

  return false;
}

function stripPremiumLinks(b) {
  return {
    ...b,
    subjects: (b.subjects || []).map(s => ({
      ...s,
      chapters: (s.chapters || []).map(c => ({
        ...c,
        lectures: (c.lectures || []).map(l => ({ ...l, link: l.isDemo ? l.link : "", notes: l.isDemo ? l.notes : "" })),
        units: (c.units || []).map(u => ({
          ...u,
          lectures: (u.lectures || []).map(l => ({ ...l, link: l.isDemo ? l.link : "", notes: l.isDemo ? l.notes : "" })),
        })),
      })),
    })),
  };
}

// ── Points helper ─────────────────────────────────────────────────────────────
// Points = valid referrals since current periodStart − spent in RewardRedemptions
async function getPointsBreakdown(userId) {
  const uid = String(userId);
  try {
    const rp = await ReferralPremium.findOne({ userId: uid });
    const periodStart = rp ? rp.periodStart : new Date(0);

    // Referral points (only force-verified refs in current period count)
    const referrals = await Referral.countDocuments({
      referrerId: uid,
      forceVerified: true,
      createdAt: { $gte: periodStart },
    });

    // Spin wheel earnings (all-time, since spins are independent of premium period)
    const spinAgg = await SpinHistory.aggregate([
      { $match: { userId: uid } },
      { $group: { _id: null, total: { $sum: "$pointsWon" } } },
    ]);
    const spinPoints = spinAgg.length ? spinAgg[0].total : 0;

    const spentDocs = await RewardRedemption.find({ userId: uid });
    const spent = spentDocs.reduce((a, d) => a + d.pointsCost, 0);
    const points = Math.max(0, referrals + spinPoints - spent);
    return { referrals, spinPoints, spent, points };
  } catch (e) {
    return { referrals: 0, spinPoints: 0, spent: 0, points: 0 };
  }
}

// ─── Batch Routes ─────────────────────────────────────────────────────────────

router.get("/batches", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const admin  = isAdminRequest(req);
    const batches = await Batch.find(admin ? {} : { isPublic: true }).sort({ order: 1 });

    const result = await Promise.all(batches.map(async (b) => {
      const obj = b.toObject();
      if (!b.isPremium) return obj;
      const access = userId ? await hasPremiumAccess(userId, b) : false;
      if (access) return obj;
      return stripPremiumLinks(obj);
    }));

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/batches/:id", async (req, res) => {
  try {
    const userId = getRequestUserId(req);
    const admin  = isAdminRequest(req);
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });
    if (!admin && !b.isPublic) return res.status(403).json({ error: "Not public" });

    const obj = b.toObject();
    if (!b.isPremium) return res.json(obj);
    const access = userId ? await hasPremiumAccess(userId, b) : false;
    res.json(access ? obj : stripPremiumLinks(obj));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches", verifyAdmin, async (req, res) => {
  try {
    const { name, description, pic, isPremium, order } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const b = await Batch.create({ name, description: description || "", pic: pic || "", isPremium: !!isPremium, order: order || 0 });
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:id", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!b) return res.status(404).json({ error: "Not found" });
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:id", verifyAdmin, async (req, res) => {
  try {
    await Batch.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:id/publish", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Not found" });
    b.isPublic = !b.isPublic;
    await b.save();
    res.json({ isPublic: b.isPublic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Subjects
router.post("/batches/:id/subjects", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    b.subjects.push(req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:id/subjects/:sid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    const s = b.subjects.id(req.params.sid);
    if (!s) return res.status(404).json({ error: "Subject not found" });
    Object.assign(s, req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:id/subjects/:sid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    b.subjects.id(req.params.sid)?.deleteOne();
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Chapters
router.post("/batches/:id/subjects/:sid/chapters", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    const s = b.subjects.id(req.params.sid);
    if (!s) return res.status(404).json({ error: "Subject not found" });
    s.chapters.push(req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:id/subjects/:sid/chapters/:cid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    const s = b.subjects.id(req.params.sid);
    if (!s) return res.status(404).json({ error: "Subject not found" });
    const c = s.chapters.id(req.params.cid);
    if (!c) return res.status(404).json({ error: "Chapter not found" });
    Object.assign(c, req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:id/subjects/:sid/chapters/:cid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.id);
    if (!b) return res.status(404).json({ error: "Batch not found" });
    const s = b.subjects.id(req.params.sid);
    if (!s) return res.status(404).json({ error: "Subject not found" });
    s.chapters.id(req.params.cid)?.deleteOne();
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Units
router.post("/batches/:bid/subjects/:sid/chapters/:cid/units", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid);
    const s = b?.subjects.id(req.params.sid);
    const c = s?.chapters.id(req.params.cid);
    if (!c) return res.status(404).json({ error: "Not found" });
    c.units.push(req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid);
    const s = b?.subjects.id(req.params.sid);
    const c = s?.chapters.id(req.params.cid);
    const u = c?.units.id(req.params.uid);
    if (!u) return res.status(404).json({ error: "Not found" });
    Object.assign(u, req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid);
    const s = b?.subjects.id(req.params.sid);
    const c = s?.chapters.id(req.params.cid);
    c?.units.id(req.params.uid)?.deleteOne();
    await b?.save();
    res.json(b?.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lectures
router.post("/batches/:bid/subjects/:sid/chapters/:cid/lectures", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid);
    const s = b?.subjects.id(req.params.sid);
    const c = s?.chapters.id(req.params.cid);
    if (!c) return res.status(404).json({ error: "Not found" });
    c.lectures.push(req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid);
    const s = b?.subjects.id(req.params.sid);
    const c = s?.chapters.id(req.params.cid);
    const u = c?.units.id(req.params.uid);
    if (!u) return res.status(404).json({ error: "Not found" });
    u.lectures.push(req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid);
    const s = b?.subjects.id(req.params.sid);
    const c = s?.chapters.id(req.params.cid);
    const l = c?.lectures.id(req.params.lid);
    if (!l) return res.status(404).json({ error: "Not found" });
    Object.assign(l, req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid);
    const s = b?.subjects.id(req.params.sid);
    const c = s?.chapters.id(req.params.cid);
    const u = c?.units.id(req.params.uid);
    const l = u?.lectures.id(req.params.lid);
    if (!l) return res.status(404).json({ error: "Not found" });
    Object.assign(l, req.body);
    await b.save();
    res.json(b.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid);
    const s = b?.subjects.id(req.params.sid);
    const c = s?.chapters.id(req.params.cid);
    c?.lectures.id(req.params.lid)?.deleteOne();
    await b?.save();
    res.json(b?.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const b = await Batch.findById(req.params.bid);
    const s = b?.subjects.id(req.params.sid);
    const c = s?.chapters.id(req.params.cid);
    const u = c?.units.id(req.params.uid);
    u?.lectures.id(req.params.lid)?.deleteOne();
    await b?.save();
    res.json(b?.toObject());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reorder
router.post("/batches/reorder", verifyAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ error: "ids array required" });
    await Promise.all(ids.map((id, i) => Batch.findByIdAndUpdate(id, { order: i })));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Access (ad-watch) ─────────────────────────────────────────────────────────

router.get("/access/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const record = await Access.findOne({ userId });
    const today  = getTodayIST();
    const claimsToday = (record && record.claimDay === today) ? (record.claimsToday || 0) : 0;
    const claimsLeft  = Math.max(0, 3 - claimsToday);
    if (!record || record.expiresAt < new Date()) {
      return res.json({ hasAccess: false, expiresAt: null, claimsToday, claimsLeft });
    }
    res.json({ hasAccess: true, expiresAt: record.expiresAt, claimsToday, claimsLeft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Issue one-time token before showing ad
router.post("/access/token/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const today  = getTodayIST();
    const existing = await Access.findOne({ userId });
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday || 0) : 0;
    if (claimsToday >= 3) {
      return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao.", claimsToday: 3, claimsLeft: 0 });
    }
    await AdToken.deleteMany({ userId });
    const token     = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await AdToken.create({ userId, token, expiresAt });
    res.json({ token, claimsToday, claimsLeft: 3 - claimsToday });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Claim access with token (min 15 s after issue)
router.post("/access/claim/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });

    const record = await AdToken.findOne({ userId, token });
    if (!record) return res.status(403).json({ error: "Invalid or expired token. Please watch the ad again." });
    if (record.expiresAt < new Date()) return res.status(403).json({ error: "Token expired. Please watch the ad again." });
    const elapsed = (Date.now() - new Date(record.issuedAt)) / 1000;
    if (elapsed < 15) return res.status(403).json({ error: "Ad not fully watched. Please wait..." });

    const today = getTodayIST();
    const existing = await Access.findOne({ userId });
    const claimsToday = (existing && existing.claimDay === today) ? (existing.claimsToday || 0) : 0;
    if (claimsToday >= 3) {
      await AdToken.deleteOne({ _id: record._id });
      return res.status(429).json({ error: "Aaj ke 3 claims ho gaye! Kal wapas aao." });
    }
    await AdToken.deleteOne({ _id: record._id });
    const baseTime  = (existing && existing.expiresAt > new Date()) ? existing.expiresAt : new Date();
    const expiresAt = new Date(baseTime.getTime() + 8 * 60 * 60 * 1000);
    const newClaims = claimsToday + 1;
    await Access.findOneAndUpdate({ userId }, { userId, expiresAt, claimsToday: newClaims, claimDay: today }, { upsert: true, new: true });
    res.json({ hasAccess: true, expiresAt, claimsToday: newClaims, claimsLeft: 3 - newClaims });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Referral bonus access (18h per valid referral, called from bot)
router.post("/access/referral/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const hours  = parseInt(req.body && req.body.hours) || 18;
    const existing = await Access.findOne({ userId });
    const now = new Date();
    const base = (existing && existing.expiresAt > now) ? existing.expiresAt : now;
    const expiresAt = new Date(base.getTime() + hours * 60 * 60 * 1000);
    await Access.findOneAndUpdate({ userId }, { userId, expiresAt }, { upsert: true, new: true });
    res.json({ success: true, expiresAt, hours });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: grant access to any user
router.post("/access/grant", verifyAdmin, async (req, res) => {
  try {
    const { userId, hours } = req.body;
    if (!userId || !hours) return res.status(400).json({ error: "userId and hours required" });
    const h = parseInt(hours);
    if (isNaN(h) || h <= 0) return res.status(400).json({ error: "hours must be positive" });
    const existing = await Access.findOne({ userId: String(userId) });
    const now  = new Date();
    const base = (existing && existing.expiresAt > now) ? existing.expiresAt : now;
    const expiresAt = new Date(base.getTime() + h * 60 * 60 * 1000);
    await Access.findOneAndUpdate({ userId: String(userId) }, { userId: String(userId), expiresAt }, { upsert: true, new: true });
    res.json({ success: true, expiresAt, hours: h });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Daily Video Limit ─────────────────────────────────────────────────────────
const DAILY_LIMIT = 10;

router.get("/daily-limit/:userId", async (req, res) => {
  try {
    const userId  = parseInt(req.params.userId, 10);
    const today   = getTodayIST();
    const record  = await WatchedLecture.findOne({ userId, watchDay: today });
    const count   = record ? record.count : 0;
    const remaining = Math.max(0, DAILY_LIMIT - count);
    res.json({ count, remaining, limit: DAILY_LIMIT, today });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/daily-limit/:userId/watch", async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    const today  = getTodayIST();
    const record = await WatchedLecture.findOne({ userId, watchDay: today });
    const count  = record ? record.count : 0;
    if (count >= DAILY_LIMIT) {
      return res.status(429).json({ error: "Daily limit reached", count, remaining: 0, limit: DAILY_LIMIT });
    }
    await WatchedLecture.findOneAndUpdate(
      { userId, watchDay: today },
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );
    const newCount = count + 1;
    res.json({ count: newCount, remaining: Math.max(0, DAILY_LIMIT - newCount), limit: DAILY_LIMIT });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Referral System ───────────────────────────────────────────────────────────

// Get referral stats + premium progress for a user
router.get("/refer/stats/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { referrals, spent, points } = await getPointsBreakdown(userId);

    // Premium progress in current cycle
    const rp = await ReferralPremium.findOne({ userId });
    const now = new Date();
    const periodStart = rp ? rp.periodStart : new Date(0);
    const premiumActive = !!(rp && rp.expiresAt && rp.expiresAt > now);
    const premiumExpiresAt = premiumActive ? rp.expiresAt : null;

    // Count only force-verified referrals since period start toward premium
    const premiumReferrals = await Referral.countDocuments({
      referrerId: userId,
      forceVerified: true,
      createdAt: { $gte: periodStart },
    });

    res.json({
      referrals,           // total all-time valid refs (for points)
      points,              // spendable balance
      spent,
      premiumReferrals,    // refs in current premium period
      premiumGoal: PREMIUM_REFERRAL_COUNT,
      premiumActive,
      premiumExpiresAt,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Record a referral (called from bot on /start with ref_ param)
router.post("/refer/record", async (req, res) => {
  try {
    const { referrerId, referredId, isNewUser } = req.body;
    if (!referrerId || !referredId) return res.status(400).json({ error: "Missing fields" });
    if (referrerId === referredId) return res.status(400).json({ error: "Cannot refer yourself" });
    if (!isNewUser) return res.json({ success: false, isNew: false, reason: "Not a new user" });

    const existing = await Referral.findOne({ referredId });
    if (existing) return res.json({ success: false, isNew: false, reason: "Already referred" });

    await Referral.create({ referrerId, referredId, forceVerified: false });
    res.json({ success: true, isNew: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: false, reason: "Already referred" });
    res.status(500).json({ error: e.message });
  }
});

// Mark referral as force-verified (called after referred user completes force join)
// This is the key trigger: referral only counts toward premium after force join
router.post("/refer/verify", async (req, res) => {
  try {
    const { referredId } = req.body;
    if (!referredId) return res.status(400).json({ error: "referredId required" });

    const referral = await Referral.findOne({ referredId });
    if (!referral || referral.forceVerified) {
      return res.json({ success: false, alreadyVerified: !!referral?.forceVerified });
    }

    referral.forceVerified = true;
    await referral.save();

    // Check if referrer now has enough for premium unlock
    const referrerId = referral.referrerId;
    const rp = await ReferralPremium.findOne({ userId: referrerId });
    const now = new Date();

    // Ensure ReferralPremium doc exists
    let rpDoc = rp;
    if (!rpDoc) {
      rpDoc = await ReferralPremium.create({ userId: referrerId, periodStart: new Date(0) });
    }

    // If premium is currently active, skip check (they already have it)
    if (rpDoc.expiresAt && rpDoc.expiresAt > now) {
      return res.json({ success: true, premiumTriggered: false, alreadyActive: true });
    }

    // Count verified refs since period start
    const count = await Referral.countDocuments({
      referrerId,
      forceVerified: true,
      createdAt: { $gte: rpDoc.periodStart },
    });

    if (count >= PREMIUM_REFERRAL_COUNT) {
      // Unlock premium for PREMIUM_DAYS days!
      const expiresAt = new Date(now.getTime() + PREMIUM_DAYS * 24 * 60 * 60 * 1000);
      await ReferralPremium.findOneAndUpdate(
        { userId: referrerId },
        { unlockedAt: now, expiresAt },
        { upsert: true, new: true }
      );
      return res.json({ success: true, premiumTriggered: true, expiresAt, count, referrerId });
    }

    res.json({ success: true, premiumTriggered: false, count, goal: PREMIUM_REFERRAL_COUNT });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset premium period after expiry (called from bot or cron)
router.post("/refer/reset-premium/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const now = new Date();
    await ReferralPremium.findOneAndUpdate(
      { userId },
      { userId, unlockedAt: null, expiresAt: null, periodStart: now },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get referral premium status
router.get("/refer/premium/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const rp = await ReferralPremium.findOne({ userId });
    const now = new Date();

    if (!rp) return res.json({ premiumActive: false, premiumReferrals: 0, premiumGoal: PREMIUM_REFERRAL_COUNT });

    const premiumActive = !!(rp.expiresAt && rp.expiresAt > now);

    // Auto-reset expired premium
    if (rp.expiresAt && rp.expiresAt <= now && rp.unlockedAt) {
      await ReferralPremium.findOneAndUpdate(
        { userId },
        { unlockedAt: null, expiresAt: null, periodStart: now }
      );
      return res.json({ premiumActive: false, premiumReferrals: 0, premiumGoal: PREMIUM_REFERRAL_COUNT, justExpired: true });
    }

    const premiumReferrals = await Referral.countDocuments({
      referrerId: userId,
      forceVerified: true,
      createdAt: { $gte: rp.periodStart },
    });

    res.json({
      premiumActive,
      premiumExpiresAt: premiumActive ? rp.expiresAt : null,
      premiumReferrals,
      premiumGoal: PREMIUM_REFERRAL_COUNT,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Points Rewards ────────────────────────────────────────────────────────────
const REWARD_CATALOG = {
  accessPass: { cost: 10, durationHours: 24,    label: "24h Access Pass" },
  batch24h:   { cost: 15, durationHours: 24,    label: "24h Batch Access" },
  batch7d:    { cost: 50, durationHours: 24 * 7, label: "7-Day Batch Access" },
};

router.get("/rewards/catalog", (req, res) => {
  res.json(Object.entries(REWARD_CATALOG).map(([type, d]) => ({ type, ...d })));
});

router.get("/rewards/history/:userId", async (req, res) => {
  try {
    const history = await RewardRedemption.find({ userId: req.params.userId }).sort({ redeemedAt: -1 }).limit(20);
    res.json(history);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/rewards/active/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const now    = new Date();
    const batchAccess = await BatchRewardAccess.find({ userId, expiresAt: { $gt: now } });
    const accessPass  = await RewardRedemption.findOne({ userId, rewardType: "accessPass", expiresAt: { $gt: now } });
    res.json({ batchAccess, accessPass: accessPass || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/rewards/redeem", async (req, res) => {
  try {
    const { userId, rewardType, batchId } = req.body;
    if (!userId || !rewardType) return res.status(400).json({ error: "userId and rewardType required" });

    const reward = REWARD_CATALOG[rewardType];
    if (!reward) return res.status(400).json({ error: "Unknown reward type" });

    if ((rewardType === "batch24h" || rewardType === "batch7d") && !batchId) {
      return res.status(400).json({ error: "batchId required for batch rewards" });
    }

    // Check balance
    const { points } = await getPointsBreakdown(userId);
    if (points < reward.cost) {
      return res.status(400).json({ error: `Not enough points. Need ${reward.cost}, have ${points}.` });
    }

    const now       = new Date();
    const expiresAt = new Date(now.getTime() + reward.durationHours * 60 * 60 * 1000);

    let batchName = "";
    if (batchId) {
      const b = await Batch.findById(batchId);
      if (!b) return res.status(404).json({ error: "Batch not found" });
      batchName = b.name;
    }

    // Record redemption (debits from points)
    await RewardRedemption.create({ userId, rewardType, batchId: batchId || null, batchName, pointsCost: reward.cost, expiresAt });

    if (rewardType === "accessPass") {
      // Extend general access
      const existing = await Access.findOne({ userId });
      const base = (existing && existing.expiresAt > now) ? existing.expiresAt : now;
      const accExpiry = new Date(base.getTime() + reward.durationHours * 60 * 60 * 1000);
      await Access.findOneAndUpdate({ userId }, { userId, expiresAt: accExpiry }, { upsert: true, new: true });
    } else {
      // Grant batch-specific access
      await BatchRewardAccess.findOneAndUpdate(
        { userId, batchId },
        { userId, batchId, batchName, expiresAt, grantedAt: now },
        { upsert: true, new: true }
      );
    }

    const { points: newPoints } = await getPointsBreakdown(userId);
    res.json({ success: true, expiresAt, pointsSpent: reward.cost, pointsRemaining: newPoints });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Spin & Earn ───────────────────────────────────────────────────────────────
const DAILY_SPINS = 5;

router.get("/spin/status/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const today  = getTodayIST();
    const spinsUsed = await SpinHistory.countDocuments({ userId, spinDay: today });
    const spinsLeft = Math.max(0, DAILY_SPINS - spinsUsed);
    const { points } = await getPointsBreakdown(userId);
    res.json({ spinsLeft, spinsUsed, dailyLimit: DAILY_SPINS, points });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Issue a spin token before showing ad
router.post("/spin/token/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const today  = getTodayIST();
    const spinsUsed = await SpinHistory.countDocuments({ userId, spinDay: today });
    if (spinsUsed >= DAILY_SPINS) {
      return res.status(429).json({ error: "No spins left today! Come back tomorrow.", spinsLeft: 0 });
    }
    await SpinToken.deleteMany({ userId });
    const token     = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await SpinToken.create({ userId, token, expiresAt });
    res.json({ token, spinsLeft: DAILY_SPINS - spinsUsed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Claim spin result
router.post("/spin/claim/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });

    const record = await SpinToken.findOne({ userId, token });
    if (!record) return res.status(403).json({ error: "Invalid or expired token." });
    if (record.expiresAt < new Date()) return res.status(403).json({ error: "Token expired." });
    const elapsed = (Date.now() - new Date(record.issuedAt)) / 1000;
    if (elapsed < 15) return res.status(403).json({ error: "Ad not fully watched." });

    await SpinToken.deleteOne({ _id: record._id });

    const today = getTodayIST();
    const spinsUsed = await SpinHistory.countDocuments({ userId, spinDay: today });
    if (spinsUsed >= DAILY_SPINS) {
      return res.status(429).json({ error: "No spins left today!" });
    }

    // Random points 1-5
    const pointsWon = Math.floor(Math.random() * 5) + 1;
    await SpinHistory.create({ userId, pointsWon, spinDay: today });

    // Add points via a dummy referral-equivalent: we store as a reward redemption with negative cost
    // Actually, spin points are stored separately. Let's use a SpinPoints collection to track earnings.
    // For simplicity: we track spin history separately; the getPointsBreakdown includes spin points.
    // We'll update getPointsBreakdown to include spin earnings too.

    const spinsLeft = Math.max(0, DAILY_SPINS - (spinsUsed + 1));
    res.json({ success: true, pointsWon, spinsLeft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Auto Lecture Session (green tick) ─────────────────────────────────────────

router.get("/auto-lec/status", (req, res) => {
  res.json(autoLectureSession);
});

router.post("/auto-lec/start", verifyAdmin, async (req, res) => {
  try {
    const { batchId, subjectId, chapterId, unitId } = req.body;
    if (!batchId || !subjectId || !chapterId) {
      return res.status(400).json({ error: "batchId, subjectId, chapterId required" });
    }

    const b  = await Batch.findById(batchId);
    const s  = b?.subjects.id(subjectId);
    const c  = s?.chapters.id(chapterId);
    const u  = unitId ? c?.units.id(unitId) : null;
    if (!c) return res.status(404).json({ error: "Chapter not found" });

    Object.assign(autoLectureSession, {
      active:       true,
      batchId,
      subjectId,
      chapterId,
      unitId:       unitId || null,
      lectureCount: 0,
      batchName:    b.name,
      subjectName:  s.name,
      chapterName:  c.name,
      unitName:     u ? u.name : "",
    });
    await _saveAutoSession();
    res.json(autoLectureSession);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/auto-lec/stop", verifyAdmin, async (req, res) => {
  try {
    Object.assign(autoLectureSession, {
      active: false, batchId: null, subjectId: null, chapterId: null,
      unitId: null, lectureCount: 0, batchName: "", subjectName: "", chapterName: "", unitName: "",
    });
    await _saveAutoSession();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Force Join Check ──────────────────────────────────────────────────────────
// Handle both GET (legacy) and POST (current HTML) for force-join check
async function _forceJoinCheckHandler(req, res) {
  try {
    // HTML sends POST with { userId } in body; legacy GET uses x-tg-init-data header
    const userId = (req.body && req.body.userId)
      ? String(req.body.userId)
      : getRequestUserId(req);

    const forceJoinChannels = (process.env.FORCE_JOIN_CHANNELS || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    if (!forceJoinChannels.length) return res.json({ allJoined: true, channels: [] });

    // Need userId to check membership; if not in Telegram context, allow through
    if (!userId || userId.startsWith("guest_")) {
      return res.json({ allJoined: true, channels: [] });
    }

    const TG = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;
    const results = [];
    let allJoined = true;

    for (const channelId of forceJoinChannels) {
      try {
        // Fetch channel metadata (name, username, invite_link) and member status in parallel
        const [chatRes, memberRes] = await Promise.all([
          fetch(`${TG}/getChat?chat_id=${encodeURIComponent(channelId)}`,
            { signal: AbortSignal.timeout(6000) }),
          fetch(`${TG}/getChatMember?chat_id=${encodeURIComponent(channelId)}&user_id=${userId}`,
            { signal: AbortSignal.timeout(6000) }),
        ]);

        const chatData   = await chatRes.json();
        const memberData = await memberRes.json();

        const chat    = chatData.result  || {};
        const member  = memberData.result || {};
        const status  = member.status;
        const joined  = ["member", "administrator", "creator"].includes(status);
        if (!joined) allJoined = false;

        const username = chat.username;
        const name     = chat.title || (username ? "@" + username : channelId);
        const link     = username
          ? `https://t.me/${username}`
          : (chat.invite_link || null);

        results.push({ id: channelId, name, joined, link, photoUrl: null });
      } catch {
        allJoined = false;
        results.push({ id: channelId, name: channelId, joined: false, link: null, photoUrl: null });
      }
    }

    // All joined → inline-verify pending referral and check premium unlock
    if (allJoined) {
      try {
        const referral = await Referral.findOne({ referredId: userId, forceVerified: false });
        if (referral) {
          referral.forceVerified = true;
          await referral.save();

          const referrerId = referral.referrerId;
          const now = new Date();
          let rpDoc = await ReferralPremium.findOne({ userId: referrerId });
          if (!rpDoc) rpDoc = await ReferralPremium.create({ userId: referrerId, periodStart: new Date(0) });

          if (!rpDoc.expiresAt || rpDoc.expiresAt <= now) {
            const count = await Referral.countDocuments({
              referrerId, forceVerified: true, createdAt: { $gte: rpDoc.periodStart },
            });
            if (count >= PREMIUM_REFERRAL_COUNT) {
              const expiresAt = new Date(now.getTime() + PREMIUM_DAYS * 24 * 60 * 60 * 1000);
              await ReferralPremium.findOneAndUpdate(
                { userId: referrerId },
                { unlockedAt: now, expiresAt },
                { upsert: true }
              );
            }
          }
        }
      } catch { /* non-fatal */ }
    }

    res.json({ allJoined, channels: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

router.get("/force-join/check",  _forceJoinCheckHandler);
router.post("/force-join/check", _forceJoinCheckHandler);

// Called from force-join check when user has joined all channels
// Verifies their pending referral and potentially unlocks premium for the referrer
router.post("/refer/verify-by-user", async (req, res) => {
  try {
    const { referredId } = req.body;
    if (!referredId) return res.status(400).json({ error: "referredId required" });

    const referral = await Referral.findOne({ referredId: String(referredId) });
    if (!referral || referral.forceVerified) {
      return res.json({ success: false, reason: referral ? "already_verified" : "no_referral" });
    }

    // Mark as verified
    referral.forceVerified = true;
    await referral.save();

    const referrerId = referral.referrerId;
    const rp  = await ReferralPremium.findOne({ userId: referrerId });
    const now = new Date();

    let rpDoc = rp || await ReferralPremium.create({ userId: referrerId, periodStart: new Date(0) });

    if (rpDoc.expiresAt && rpDoc.expiresAt > now) {
      return res.json({ success: true, premiumTriggered: false, alreadyActive: true });
    }

    const count = await Referral.countDocuments({
      referrerId,
      forceVerified: true,
      createdAt: { $gte: rpDoc.periodStart },
    });

    if (count >= PREMIUM_REFERRAL_COUNT) {
      const expiresAt = new Date(now.getTime() + PREMIUM_DAYS * 24 * 60 * 60 * 1000);
      await ReferralPremium.findOneAndUpdate(
        { userId: referrerId },
        { unlockedAt: now, expiresAt },
        { upsert: true, new: true }
      );
      return res.json({ success: true, premiumTriggered: true, expiresAt, count, referrerId });
    }

    res.json({ success: true, premiumTriggered: false, count, goal: PREMIUM_REFERRAL_COUNT, referrerId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Announcements ─────────────────────────────────────────────────────────────
const announcementSchema = new mongoose.Schema({
  emoji:     { type: String, default: "📢" },
  heading:   { type: String, required: true },
  body:      { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const Announcement = mongoose.models.Announcement || mongoose.model("Announcement", announcementSchema);

router.get("/announcements", async (req, res) => {
  try {
    const items = await Announcement.find({}).sort({ createdAt: -1 }).limit(10);
    res.json(items);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/announcements", verifyAdmin, async (req, res) => {
  try {
    const { emoji, heading, body } = req.body;
    if (!heading || !body) return res.status(400).json({ error: "heading and body required" });
    const a = await Announcement.create({ emoji: emoji || "📢", heading, body });
    res.json(a);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete("/announcements/:id", verifyAdmin, async (req, res) => {
  try {
    await Announcement.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Rewards Summary (all-in-one for the Rewards tab) ─────────────────────────
router.get("/rewards/summary/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const now    = new Date();

    const { referrals, spinPoints, spent, points } = await getPointsBreakdown(userId);

    const [activeAccess, activeBatchRewards, recentHistory] = await Promise.all([
      Access.findOne({ userId, expiresAt: { $gt: now } }),
      BatchRewardAccess.find({ userId, expiresAt: { $gt: now } }).lean(),
      RewardRedemption.find({ userId }).sort({ redeemedAt: -1 }).limit(10).lean(),
    ]);

    res.json({
      points,
      referrals,
      spinPoints,
      spent,
      catalog: {
        accessPass: { cost: REWARD_CATALOG.accessPass.cost, label: REWARD_CATALOG.accessPass.label },
        batch24h:   { cost: REWARD_CATALOG.batch24h.cost,   label: REWARD_CATALOG.batch24h.label   },
        batch7d:    { cost: REWARD_CATALOG.batch7d.cost,    label: REWARD_CATALOG.batch7d.label    },
      },
      accessPass: activeAccess
        ? { active: true,  expiresAt: activeAccess.expiresAt }
        : { active: false, expiresAt: null },
      activeBatchRewards: activeBatchRewards.map(b => ({
        batchId:   b.batchId,
        batchName: b.batchName,
        expiresAt: b.expiresAt,
      })),
      recentHistory,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const now = new Date();
    const batches = await Batch.find({});
    let totalSubjects = 0, totalChapters = 0, totalLectures = 0;
    batches.forEach(b => {
      totalSubjects += b.subjects.length;
      b.subjects.forEach(s => {
        totalChapters += s.chapters.length;
        s.chapters.forEach(c => {
          totalLectures += c.lectures.length;
          c.units.forEach(u => { totalLectures += u.lectures.length; });
        });
      });
    });

    const UserModel = mongoose.models.User;
    const totalUsers  = UserModel ? await UserModel.countDocuments({}) : "N/A";
    const recentUsers = UserModel ? await UserModel.countDocuments({ firstSeen: { $gte: new Date(now - 7 * 86400000) } }) : "N/A";
    const activeAccess = await Access.countDocuments({ expiresAt: { $gt: now } });
    const totalRefs   = await Referral.countDocuments({});
    const activePremiums = await ReferralPremium.countDocuments({ expiresAt: { $gt: now } });
    const uniqueReferrers = (await Referral.distinct("referrerId")).length;

    res.json({
      content:  { totalBatches: batches.length, publicBatches: batches.filter(b => b.isPublic).length, privateBatches: batches.filter(b => !b.isPublic).length, totalSubjects, totalChapters, totalLectures },
      users:    { totalUsers, recentUsers },
      access:   { totalAccess: await Access.countDocuments({}), activeAccess },
      referrals: { totalReferrals: totalRefs, uniqueReferrers, activePremiums },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Export shared objects used by server.js
module.exports = router;
module.exports.autoLectureSession = autoLectureSession;
module.exports.autoAddLecture     = autoAddLecture;
module.exports.Referral           = Referral;
module.exports.ReferralPremium    = ReferralPremium;
module.exports.Access             = Access;
