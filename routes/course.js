const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const mongoose = require("mongoose");
const Batch = require("../models/Course");

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");

function verifyAdmin(req, res, next) {
  const initData = req.headers["x-tg-init-data"];
  if (!initData) return res.status(401).json({ error: "Unauthorized" });
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash"); params.delete("hash");
    const dataStr = Array.from(params.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const expected = crypto.createHmac("sha256", secret).update(dataStr).digest("hex");
    if (expected !== hash) return res.status(401).json({ error: "Invalid signature" });
    const user = JSON.parse(params.get("user") || "{}");
    if (user.id !== OWNER_ID) return res.status(403).json({ error: "Forbidden" });
    next();
  } catch { return res.status(401).json({ error: "Verification failed" }); }
}

// ── Batches ───────────────────────────────────────────────────────────────────
router.get("/batches", async (req, res) => {
  try { res.json(await Batch.find({}).sort({ order: 1 })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/batches", verifyAdmin, async (req, res) => {
  try {
    const count = await Batch.countDocuments();
    res.json(await Batch.create({ name: req.body.name, pic: req.body.pic || "", description: req.body.description || "", order: count, isPublic: false }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/batches/:bid/publish", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Not found" });
    batch.isPublic = !batch.isPublic; await batch.save();
    res.json({ success: true, isPublic: batch.isPublic });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/batches/:bid", verifyAdmin, async (req, res) => {
  try { await Batch.findByIdAndDelete(req.params.bid); res.json({ success: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/batches/:bid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Not found" });
    if (req.body.name) batch.name = req.body.name;
    if (req.body.description !== undefined) batch.description = req.body.description;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Subjects ──────────────────────────────────────────────────────────────────
router.post("/batches/:bid/subjects", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Not found" });
    batch.subjects.push({ name: req.body.name, icon: req.body.icon||"📚", color: req.body.color||"#4f8ef7", order: batch.subjects.length });
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/batches/:bid/subjects/:sid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    if (!batch) return res.status(404).json({ error: "Not found" });
    batch.subjects = batch.subjects.filter(s => s._id.toString() !== req.params.sid);
    await batch.save(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/batches/:bid/subjects/:sid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    if (!s) return res.status(404).json({ error: "Not found" });
    if (req.body.name) s.name = req.body.name;
    if (req.body.icon) s.icon = req.body.icon;
    if (req.body.color) s.color = req.body.color;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chapters ──────────────────────────────────────────────────────────────────
router.post("/batches/:bid/subjects/:sid/chapters", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    if (!s) return res.status(404).json({ error: "Not found" });
    s.chapters.push({ name: req.body.name, order: s.chapters.length });
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/batches/:bid/subjects/:sid/chapters/:cid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    if (!s) return res.status(404).json({ error: "Not found" });
    s.chapters = s.chapters.filter(c => c._id.toString() !== req.params.cid);
    await batch.save(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/batches/:bid/subjects/:sid/chapters/:cid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    if (!c) return res.status(404).json({ error: "Not found" });
    if (req.body.name) c.name = req.body.name;
    if (req.body.comingSoon !== undefined) c.comingSoon = req.body.comingSoon;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Units ─────────────────────────────────────────────────────────────────────
router.post("/batches/:bid/subjects/:sid/chapters/:cid/units", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    if (!c) return res.status(404).json({ error: "Not found" });
    c.units.push({ name: req.body.name, order: c.units.length });
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    if (!c) return res.status(404).json({ error: "Not found" });
    c.units = c.units.filter(u => u._id.toString() !== req.params.uid);
    await batch.save(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    const u = c && c.units.id(req.params.uid);
    if (!u) return res.status(404).json({ error: "Not found" });
    if (req.body.name) u.name = req.body.name;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lectures (chapter-level) ──────────────────────────────────────────────────
router.post("/batches/:bid/subjects/:sid/chapters/:cid/lectures", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    if (!c) return res.status(404).json({ error: "Not found" });
    c.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes||"", order: c.lectures.length });
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    if (!c) return res.status(404).json({ error: "Not found" });
    c.lectures = c.lectures.filter(l => l._id.toString() !== req.params.lid);
    await batch.save(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/batches/:bid/subjects/:sid/chapters/:cid/lectures/:lid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    const l = c && c.lectures.id(req.params.lid);
    if (!l) return res.status(404).json({ error: "Not found" });
    if (req.body.name) l.name = req.body.name;
    if (req.body.link !== undefined) l.link = req.body.link;
    if (req.body.notes !== undefined) l.notes = req.body.notes;
    if (req.body.comingSoon !== undefined) l.comingSoon = req.body.comingSoon;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Lectures (unit-level) ─────────────────────────────────────────────────────
router.post("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    const u = c && c.units.id(req.params.uid);
    if (!u) return res.status(404).json({ error: "Not found" });
    u.lectures.push({ name: req.body.name, link: req.body.link, notes: req.body.notes||"", order: u.lectures.length });
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    const u = c && c.units.id(req.params.uid);
    if (!u) return res.status(404).json({ error: "Not found" });
    u.lectures = u.lectures.filter(l => l._id.toString() !== req.params.lid);
    await batch.save(); res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch("/batches/:bid/subjects/:sid/chapters/:cid/units/:uid/lectures/:lid/edit", verifyAdmin, async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.bid);
    const s = batch && batch.subjects.id(req.params.sid);
    const c = s && s.chapters.id(req.params.cid);
    const u = c && c.units.id(req.params.uid);
    const l = u && u.lectures.id(req.params.lid);
    if (!l) return res.status(404).json({ error: "Not found" });
    if (req.body.name) l.name = req.body.name;
    if (req.body.link !== undefined) l.link = req.body.link;
    if (req.body.notes !== undefined) l.notes = req.body.notes;
    if (req.body.comingSoon !== undefined) l.comingSoon = req.body.comingSoon;
    await batch.save(); res.json(batch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Announcements ─────────────────────────────────────────────────────────────
const annSchema = new mongoose.Schema({
  emoji:    { type: String, default: "📢" },
  heading:  { type: String, required: true },
  body:     { type: String, required: true },
  createdAt:{ type: Date, default: Date.now },
});
const Announcement = mongoose.model("Announcement", annSchema);

router.get("/announcements", async (req, res) => {
  try { res.json(await Announcement.find().sort({ createdAt: -1 }).limit(20)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post("/announcements", verifyAdmin, async (req, res) => {
  try {
    const { emoji, heading, body } = req.body;
    if (!heading || !body) return res.status(400).json({ error: "heading and body required" });
    res.json(await Announcement.create({ emoji: emoji||"📢", heading, body }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete("/announcements/:id", verifyAdmin, async (req, res) => {
  try { await Announcement.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ad Token & 8h Access ──────────────────────────────────────────────────────
const adTokenSchema = new mongoose.Schema({
  userId:    { type: String, required: true },
  token:     { type: String, required: true, unique: true },
  issuedAt:  { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});
adTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const AdToken = mongoose.model("AdToken", adTokenSchema);

const accessSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
});
accessSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Access = mongoose.model("Access", accessSchema);

router.get("/access/:userId", async (req, res) => {
  try {
    const r = await Access.findOne({ userId: req.params.userId });
    if (!r || r.expiresAt < new Date()) return res.json({ hasAccess: false, expiresAt: null });
    res.json({ hasAccess: true, expiresAt: r.expiresAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/access/token/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const existing = await Access.findOne({ userId });
    if (existing && existing.expiresAt > new Date())
      return res.json({ hasAccess: true, expiresAt: existing.expiresAt });
    await AdToken.deleteMany({ userId });
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await AdToken.create({ userId, token, expiresAt });
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/access/claim/:userId", async (req, res) => {
  try {
    const userId = req.params.userId;
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: "Token required" });
    const record = await AdToken.findOne({ userId, token });
    if (!record) return res.status(403).json({ error: "Invalid or expired token. Please watch the ad again." });
    if (record.expiresAt < new Date()) return res.status(403).json({ error: "Token expired. Watch ad again." });
    const elapsed = (Date.now() - new Date(record.issuedAt)) / 1000;
    if (elapsed < 15) return res.status(403).json({ error: "Ad not fully watched." });
    await AdToken.deleteOne({ _id: record._id });
    // ✅ 8 hours access (not 24h)
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await Access.findOneAndUpdate({ userId }, { userId, expiresAt }, { upsert: true, new: true });
    res.json({ hasAccess: true, expiresAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Referral System ───────────────────────────────────────────────────────────
const referralSchema = new mongoose.Schema({
  referrerId:    { type: String, required: true },
  referredId:    { type: String, required: true },
  accessGranted: { type: Boolean, default: false },
  createdAt:     { type: Date, default: Date.now },
});
referralSchema.index({ referrerId: 1 });
referralSchema.index({ referredId: 1 }, { unique: true });
const Referral = mongoose.model("Referral", referralSchema);

router.get("/refer/stats/:userId", async (req, res) => {
  try {
    const referrals = await Referral.countDocuments({ referrerId: req.params.userId });
    res.json({ referrals, points: referrals });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/refer/record", async (req, res) => {
  try {
    const { referrerId, referredId, isNewUser } = req.body;
    if (!referrerId || !referredId) return res.status(400).json({ error: "Missing fields" });
    if (referrerId === referredId) return res.status(400).json({ error: "Cannot refer yourself" });
    if (!isNewUser) return res.json({ success: false, isNew: false });
    const existing = await Referral.findOne({ referredId });
    if (existing) return res.json({ success: false, isNew: false });
    await Referral.create({ referrerId, referredId });
    res.json({ success: true, isNew: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ success: false });
    res.status(500).json({ error: e.message });
  }
});

// ── Force Join (sirf Channel ID — naam/link auto Telegram se milta hai) ───────
router.get("/force-join/channels", (req, res) => {
  const ids = (process.env.FORCE_JOIN_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  res.json({ channels: ids.map(id => ({ id })), required: ids.length > 0 });
});

const _chInfoCache = new Map();
async function getChannelInfo(chatId, botToken) {
  const now = Date.now();
  const cached = _chInfoCache.get(chatId);
  if (cached && now - cached.cachedAt < 10 * 60 * 1000) return cached;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`);
    const data = await r.json();
    const chat = data.ok ? data.result : null;
    const title = chat ? (chat.title || chat.first_name || '') : '';
    const username = chat ? (chat.username || '') : '';
    let photoUrl = null;
    if (chat?.photo?.small_file_id) {
      try {
        const fr = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${chat.photo.small_file_id}`);
        const fd = await fr.json();
        if (fd.ok && fd.result.file_path)
          photoUrl = `https://api.telegram.org/file/bot${botToken}/${fd.result.file_path}`;
      } catch (_) {}
    }
    const link = username ? `https://t.me/${username}` : null;
    const info = { title, username, photoUrl, link, cachedAt: now };
    _chInfoCache.set(chatId, info);
    return info;
  } catch (_) {
    return { title: chatId, username: '', photoUrl: null, link: null, cachedAt: now };
  }
}

router.post("/force-join/check", async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });
    const ids = (process.env.FORCE_JOIN_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return res.json({ allJoined: true, channels: [] });

    const results = await Promise.all(ids.map(async (id) => {
      const info = await getChannelInfo(id, process.env.BOT_TOKEN);
      let joined = false;
      try {
        const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(id)}&user_id=${userId}`);
        const data = await r.json();
        if (data.ok) joined = ['member', 'administrator', 'creator'].includes(data.result.status);
      } catch (_) {}
      return { id, name: info.title || id, link: info.link, photoUrl: info.photoUrl || null, joined };
    }));

    const allJoined = results.every(c => c.joined);

    // ✅ Referral bonus: jab referred user saare channels join kare → referrer ko 8h bonus
    if (allJoined) {
      try {
        const referral = await Referral.findOne({ referredId: String(userId), accessGranted: false });
        if (referral) {
          const BONUS_MS = 8 * 60 * 60 * 1000;
          const existing = await Access.findOne({ userId: referral.referrerId });
          if (existing && existing.expiresAt > new Date()) {
            existing.expiresAt = new Date(existing.expiresAt.getTime() + BONUS_MS);
            await existing.save();
          } else {
            await Access.findOneAndUpdate(
              { userId: referral.referrerId },
              { userId: referral.referrerId, expiresAt: new Date(Date.now() + BONUS_MS) },
              { upsert: true, new: true }
            );
          }
          referral.accessGranted = true;
          await referral.save();
          fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: parseInt(referral.referrerId),
              text: `🎁 *Bonus Access Mila!*\n\nAapke referral ne saare channels join kar liye!\n\n✅ Aapko *8 ghante ka bonus access* diya gaya! 🕐`,
              parse_mode: 'Markdown',
            }),
          }).catch(() => {});
        }
      } catch (err) { console.error("Referral bonus error:", err.message); }
    }

    res.json({ allJoined, channels: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
