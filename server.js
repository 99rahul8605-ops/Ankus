"use strict";
/**
 * server.js — StuBot
 * ─────────────────────────────────────────────────────────────────────────────
 * Base: CA Inter Lecture Bot (Original) merged with user's StuBot features.
 * Database: MongoDB only (no SQLite).
 * Removed: Payment system (UPI/payment groups).
 * Added:   Referral Premium unlock (5 verified referrals = 7 days premium).
 *          Multi-admin system, Force Join, /giveaccess, daily lecture limit,
 *          Points system, Spin wheel, Auto green tick, File Store.
 */

try { require("dotenv").config(); } catch { /* dotenv optional */ }

const TelegramBot = require("node-telegram-bot-api");
const mongoose    = require("mongoose");
const express     = require("express");
const path        = require("path");
const crypto      = require("crypto");

// ── Env ───────────────────────────────────────────────────────────────────────
const TOKEN              = process.env.BOT_TOKEN;
const MONGO_URI          = process.env.MONGO_URI;
const WEB_URL            = process.env.WEB_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN && "https://" + process.env.RAILWAY_PUBLIC_DOMAIN);
const PORT               = process.env.PORT || 3000;
const OWNER_ID           = parseInt(process.env.OWNER_ID || "0");
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID ? parseInt(process.env.STORAGE_CHANNEL_ID) : null;
const PREMIUM_REFERRAL_COUNT = parseInt(process.env.PREMIUM_REFERRAL_COUNT || "5");
const PREMIUM_DAYS       = parseInt(process.env.PREMIUM_DAYS || "7");

let BOT_USERNAME = "";
let bot = null;

if (!TOKEN || !MONGO_URI || !OWNER_ID) {
  console.error("Missing required env: BOT_TOKEN, MONGO_URI, OWNER_ID");
  process.exit(1);
}
if (!WEB_URL) {
  console.error("Missing WEB_URL (also auto-detected from RENDER_EXTERNAL_URL or RAILWAY_PUBLIC_DOMAIN)");
  process.exit(1);
}
if (!STORAGE_CHANNEL_ID) {
  console.warn("Warning: STORAGE_CHANNEL_ID not set — files use direct file_id (not bot-change safe).");
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const esc  = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Helpers ───────────────────────────────────────────────────────────────────
function isOwner(userId) { return userId === OWNER_ID || adminSet.has(String(userId)); }
function isGroupChat(msg) { return msg.chat && (msg.chat.type === "group" || msg.chat.type === "supergroup"); }
function formatIST(d) {
  return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true,
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function nf(n) { return typeof n === "number" ? n.toLocaleString("en-IN") : String(n); }

// ─── Schemas ──────────────────────────────────────────────────────────────────

const fileSchema = new mongoose.Schema({
  code:          { type: String, required: true, unique: true, index: true },
  file_id:       { type: String, required: true },
  file_type:     { type: String, required: true },
  file_name:     { type: String, default: "file" },
  uploaded_by:   { type: Number },
  expires_at:    { type: Date, default: null },
  delivered_to:  [{ type: Number }],
  created_at:    { type: Date, default: Date.now },
  channel_msg_id:{ type: Number, default: null },
});
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkBatchSchema = new mongoose.Schema({
  batch_code: { type: String, required: true, unique: true, index: true },
  user_id:    { type: Number, required: true },
  files: [{
    file_id:   { type: String, required: true },
    file_type: { type: String, required: true },
    file_name: { type: String, default: "file" },
    channel_msg_id: { type: Number, default: null },
  }],
  created_at: { type: Date, default: Date.now },
});
const BulkBatch = mongoose.model("BulkBatch", bulkBatchSchema);

const pendingDeleteSchema = new mongoose.Schema({
  chat_id:    { type: Number, required: true },
  message_id: { type: Number, required: true },
  delete_at:  { type: Date,   required: true },
});
const PendingDelete = mongoose.model("PendingDelete", pendingDeleteSchema);

const userSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true },
  firstName: { type: String, default: "" },
  lastName:  { type: String, default: "" },
  username:  { type: String, default: "" },
  firstSeen: { type: Date, default: Date.now },
  lastSeen:  { type: Date, default: Date.now },
});
const User = mongoose.model("User", userSchema);

const adminSchema = new mongoose.Schema({
  adminId: { type: String, required: true, unique: true },
  addedBy: { type: String, required: true },
  addedAt: { type: Date, default: Date.now },
});
const Admin = mongoose.model("Admin", adminSchema);

const dailyVideoLimitSchema = new mongoose.Schema({
  userId:    { type: Number, required: true, unique: true },
  count:     { type: Number, default: 0 },
  resetDate: { type: String, required: true }, // 'YYYY-MM-DD' IST
});
const DailyVideoLimit = mongoose.model("DailyVideoLimit", dailyVideoLimitSchema);

// ── Admin set (in-memory cache) ───────────────────────────────────────────────
let adminSet = new Set();

async function loadAdmins() {
  try {
    const admins = await Admin.find({});
    adminSet = new Set(admins.map(a => a.adminId));
    if (adminSet.size > 0) console.log(`Loaded ${adminSet.size} admin(s).`);
  } catch (e) { console.warn("loadAdmins failed:", e.message); }
}

// ── Video message tracking (for force-join revocation) ───────────────────────
// Maps userId → [{ chatId, messageId }]
const userVideoMessages = new Map();

function storeUserVideo(userId, chatId, messageId) {
  if (!userVideoMessages.has(userId)) userVideoMessages.set(userId, []);
  userVideoMessages.get(userId).push({ chatId, messageId });
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(async () => {
    console.log("MongoDB connected.");
    loadAdmins();

    // Migration: drop old TTL index on filerecords (links are permanent)
    try {
      await mongoose.connection.collection("filerecords").dropIndex("expires_at_1");
      console.log("Migration: TTL index dropped from filerecords.");
    } catch (e) {
      if (e.codeName !== "IndexNotFound") console.warn("dropIndex:", e.message);
    }
  })
  .catch(err => { console.error("MongoDB error:", err.message); process.exit(1); });

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (req, res) => res.json({
  status: "ok",
  uptime: process.uptime(),
  mongo:  mongoose.connection.readyState === 1 ? "connected" : "disconnected",
}));

app.get("/api/config", (req, res) => {
  const fjChannels = (process.env.FORCE_JOIN_CHANNELS || "").split(",").map(s => s.trim()).filter(Boolean);
  res.json({
    ownerId:           OWNER_ID,
    botUsername:       BOT_USERNAME || "",
    forceJoinRequired: fjChannels.length > 0,
    premiumGoal:       PREMIUM_REFERRAL_COUNT,
    premiumDays:       PREMIUM_DAYS,
  });
});

const courseRoutes           = require("./routes/course");
const { Referral, ReferralPremium, Access } = courseRoutes;
const autoLectureSession     = courseRoutes.autoLectureSession;
const autoAddLecture         = courseRoutes.autoAddLecture;

app.use("/api", courseRoutes);
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Keep-alive ping (prevent Render free-tier sleep)
setInterval(async () => {
  const url = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, "") + "/health";
  try { await fetch(url, { signal: AbortSignal.timeout(10000) }); } catch { /* non-fatal */ }
}, 4 * 60 * 1000);

// ── File store helpers ────────────────────────────────────────────────────────
function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function getUniqueCode() {
  let code, exists;
  do { code = generateCode(); exists = await FileRecord.findOne({ code }); } while (exists);
  return code;
}

async function getUniqueBatchCode() {
  let code, exists;
  do { code = "B" + generateCode(); exists = await BulkBatch.findOne({ batch_code: code }); } while (exists);
  return code;
}

function extractFileInfo(msg) {
  if (msg.video)      return { file_id: msg.video.file_id,       file_type: "video",      file_name: msg.video.file_name || msg.caption || "video.mp4" };
  if (msg.document)   return { file_id: msg.document.file_id,    file_type: "document",   file_name: msg.document.file_name || msg.caption || "file" };
  if (msg.photo)      return { file_id: msg.photo.at(-1).file_id,file_type: "photo",      file_name: msg.caption || "photo.jpg" };
  if (msg.audio)      return { file_id: msg.audio.file_id,       file_type: "audio",      file_name: msg.audio.file_name || msg.caption || "audio.mp3" };
  if (msg.voice)      return { file_id: msg.voice.file_id,       file_type: "voice",      file_name: "voice.ogg" };
  if (msg.video_note) return { file_id: msg.video_note.file_id,  file_type: "video_note", file_name: "videonote.mp4" };
  return null;
}

async function saveToStorageChannel(bot, fileInfo) {
  if (!STORAGE_CHANNEL_ID) return fileInfo;
  try {
    const caption = `📎 ${fileInfo.file_name}`;
    let sentMsg;
    switch (fileInfo.file_type) {
      case "photo":      sentMsg = await bot.sendPhoto(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video":      sentMsg = await bot.sendVideo(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "audio":      sentMsg = await bot.sendAudio(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "voice":      sentMsg = await bot.sendVoice(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
      case "video_note": sentMsg = await bot.sendVideoNote(STORAGE_CHANNEL_ID, fileInfo.file_id); break;
      default:           sentMsg = await bot.sendDocument(STORAGE_CHANNEL_ID, fileInfo.file_id, { caption }); break;
    }
    const channelInfo = extractFileInfo(sentMsg);
    if (channelInfo) return { ...channelInfo, file_name: fileInfo.file_name, channel_msg_id: sentMsg.message_id };
    return { ...fileInfo, channel_msg_id: sentMsg.message_id };
  } catch (err) { console.error("saveToStorageChannel:", err.message); return fileInfo; }
}

async function sendFile(bot, chatId, record) {
  const caption = `📎 ${record.file_name}`;
  const protect = !isOwner(chatId);
  try {
    switch (record.file_type) {
      case "photo":      return await bot.sendPhoto(chatId, record.file_id, { caption, protect_content: protect });
      case "video":      return await bot.sendVideo(chatId, record.file_id, { caption, protect_content: protect });
      case "audio":      return await bot.sendAudio(chatId, record.file_id, { caption, protect_content: protect });
      case "voice":      return await bot.sendVoice(chatId, record.file_id, { caption, protect_content: protect });
      case "video_note": return await bot.sendVideoNote(chatId, record.file_id, { protect_content: protect });
      default:           return await bot.sendDocument(chatId, record.file_id, { caption, filename: record.file_name, protect_content: protect });
    }
  } catch (err) {
    if (STORAGE_CHANNEL_ID && record.channel_msg_id) {
      try { return await bot.copyMessage(chatId, STORAGE_CHANNEL_ID, record.channel_msg_id, { caption, protect_content: protect }); } catch { /* ignored */ }
    }
    throw err;
  }
}

// ── File name filters ─────────────────────────────────────────────────────────
let rmWords      = [];
let addWords     = [];
let replaceWords = [];

function cleanFileName(name) {
  if (!name) return name;
  const extMatch = name.match(/(\.[a-zA-Z0-9]{1,6})$/);
  let result = extMatch ? name.slice(0, -extMatch[1].length) : name;

  // Remove words
  for (const w of rmWords) {
    const wN = w.toLowerCase().replace(/_/g, " ");
    let rN = result.toLowerCase().replace(/_/g, " ");
    let idx;
    while ((idx = rN.indexOf(wN)) !== -1) {
      result = result.slice(0, idx) + result.slice(idx + w.length);
      rN = result.toLowerCase().replace(/_/g, " ");
    }
  }

  // Replace words
  for (const { from, to } of replaceWords) {
    result = result.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), to);
  }

  result = result.replace(/[_ .\-:]{2,}/g, "_").replace(/^[_ .\-:]+|[_ .\-:]+$/g, "").trim();

  // Add words (suffix)
  if (addWords.length) result = (result ? result + " | " : "") + addWords.join(" | ");

  return (extMatch ? result + extMatch[1] : result) || name;
}

// ── Pending deletes ───────────────────────────────────────────────────────────
async function scheduleDelete(bot, chatId, messageId, deleteAt) {
  await PendingDelete.create({ chat_id: chatId, message_id: messageId, delete_at: deleteAt });
  const delay = Math.max(0, new Date(deleteAt) - Date.now());
  setTimeout(async () => {
    try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
    await PendingDelete.deleteOne({ chat_id: chatId, message_id: messageId }).catch(() => {});
  }, delay);
}

async function recoverPendingDeletes(bot) {
  const pending = await PendingDelete.find({});
  console.log(`Recovering ${pending.length} pending deletion(s)...`);
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.delete_at) - Date.now());
    setTimeout(async () => {
      try { await bot.deleteMessage(p.chat_id, p.message_id); } catch { /* ignore */ }
      await PendingDelete.deleteOne({ _id: p._id }).catch(() => {});
    }, delay);
  }
}

// ── Daily video limit ─────────────────────────────────────────────────────────
const DAILY_VIDEO_LIMIT = 10;

function getTodayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

async function checkAndIncrementVideoLimit(userId) {
  const today  = getTodayIST();
  let record   = await DailyVideoLimit.findOne({ userId });
  if (!record || record.resetDate !== today) {
    record = await DailyVideoLimit.findOneAndUpdate(
      { userId }, { userId, count: 0, resetDate: today }, { upsert: true, new: true }
    );
  }
  if (record.count >= DAILY_VIDEO_LIMIT) return { allowed: false, count: record.count, remaining: 0 };
  record.count += 1;
  await record.save();
  return { allowed: true, count: record.count, remaining: DAILY_VIDEO_LIMIT - record.count };
}

// ── Bot startup ───────────────────────────────────────────────────────────────
async function startBot() {
  // Clear stale polling
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=0`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) console.warn("getUpdates:", r.status);
  } catch (e) { console.warn("getUpdates skip:", e.message); }

  // Init bot with retry
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      bot = new TelegramBot(TOKEN, {
        polling: {
          interval: 2000, autoStart: false,
          params: { timeout: 30, allowed_updates: JSON.stringify(["message", "callback_query", "chat_member", "my_chat_member"]) },
        },
      });
      await bot.getMe();
      break;
    } catch (err) {
      console.error(`Bot init attempt ${attempt} failed:`, err.message);
      if (attempt === 5) throw err;
      await wait(5000 * attempt);
    }
  }

  bot.startPolling();
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log(`✅ StuBot started: @${BOT_USERNAME}`);

  // Set menu button
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ menu_button: { type: "web_app", text: "📚 Open StuBot", web_app: { url: WEB_URL } } }),
    });
  } catch { /* non-fatal */ }

  await recoverPendingDeletes(bot);

  // ─── /start ─────────────────────────────────────────────────────────────────
  bot.onText(/\/start(.*)/, async (msg, match) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const param  = (match[1] || "").trim();

    // Check new-user status BEFORE saving (for referral validation)
    const isNewUser = userId ? !(await User.findOne({ userId: String(userId) }).catch(() => null)) : false;

    // Save/update user
    if (userId) {
      User.findOneAndUpdate(
        { userId: String(userId) },
        { userId: String(userId), firstName: msg.from.first_name || "", lastName: msg.from.last_name || "", username: msg.from.username || "", lastSeen: new Date() },
        { upsert: true, new: true }
      ).catch(() => {});
    }

    // Handle ref_ parameter (referral link)
    if (param.startsWith("ref_")) {
      const referrerId = param.replace("ref_", "");
      const referredId = String(userId || "");

      bot.sendMessage(chatId,
        `👋 <b>Welcome to StuBot!</b>\n\n` +
        `🎉 You've been invited by a friend!\n\n` +
        `📌 Join all required channels below, then tap the button to start studying.\n\n` +
        `✅ Joining also helps your friend unlock <b>Premium access</b>!`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "📚 Browse Lectures", web_app: { url: WEB_URL } }]] }
        }
      );

      if (referrerId && referrerId !== referredId) {
        try {
          const r = await fetch(`http://localhost:${PORT}/api/refer/record`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ referrerId, referredId, isNewUser }),
          });
          const data = await r.json();
          if (data.isNew) {
            // Notify referrer about new (unverified) referral
            const firstName = msg.from.first_name || "Someone";
            const lastName  = msg.from.last_name ? " " + msg.from.last_name : "";
            // Get current premium progress for referrer
            try {
              const statsR  = await fetch(`http://localhost:${PORT}/api/refer/stats/${referrerId}`);
              const stats   = await statsR.json();
              const current = stats.premiumReferrals || 0;
              const goal    = PREMIUM_REFERRAL_COUNT;
              bot.sendMessage(parseInt(referrerId),
                `🎉 <b>New Referral!</b>\n\n` +
                `${esc(firstName)}${esc(lastName)} joined using your link!\n` +
                `They still need to join the required channels to be verified.\n\n` +
                `📊 Premium Progress: <b>${current}/${goal}</b>` + (current >= goal ? " ✅" : ""),
                { parse_mode: "HTML" }
              ).catch(() => {});
            } catch { /* non-fatal */ }
          }
        } catch { /* non-fatal */ }
      }
      return;
    }

    // Handle file/batch links (B... = bulk batch, others = single file)
    if (param) {
      if (param.startsWith("B")) {
        // Bulk batch delivery
        try {
          const batch = await BulkBatch.findOne({ batch_code: param });
          if (!batch) return bot.sendMessage(chatId, `❌ File not found. Link may be invalid.`);
          let hasVideo = false;
          for (const f of batch.files) {
            const sentMsg = await sendFile(bot, chatId, f);
            const isVideo = ["video", "video_note"].includes(f.file_type);
            if (isVideo && sentMsg) {
              hasVideo = true;
              const deleteAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
              await scheduleDelete(bot, chatId, sentMsg.message_id, deleteAt);
              storeUserVideo(userId, chatId, sentMsg.message_id);
            }
          }
          if (hasVideo) {
            await bot.sendMessage(chatId, `⚠️ Videos will be auto-deleted from this chat after <b>6 hours</b>.`, { parse_mode: "HTML" });
          }
        } catch (err) {
          console.error("Bulk delivery error:", err.message);
          bot.sendMessage(chatId, `❌ Could not send files. Please try again.`);
        }
        return;
      }

      // Single file delivery
      try {
        const record = await FileRecord.findOne({ code: { $regex: new RegExp(`^${param}$`, "i") } });
        if (!record) return bot.sendMessage(chatId, `❌ File not found. Link may be invalid.`);

        const isVideo = ["video", "video_note"].includes(record.file_type);
        if (isVideo) {
          const limitResult = await checkAndIncrementVideoLimit(userId);
          if (!limitResult.allowed) {
            return bot.sendMessage(chatId,
              `⏳ <b>Daily limit reached!</b>\n\n` +
              `You've watched ${DAILY_VIDEO_LIMIT} videos today.\n` +
              `🕛 Resets at midnight IST.`,
              { parse_mode: "HTML" }
            );
          }
        }

        const sentMsg = await sendFile(bot, chatId, record);

        if (isVideo && sentMsg) {
          const deleteAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
          await scheduleDelete(bot, chatId, sentMsg.message_id, deleteAt);
          storeUserVideo(userId, chatId, sentMsg.message_id);
          const lResult = await checkAndIncrementVideoLimit(userId).catch(() => null);
          const remaining = lResult ? lResult.remaining : "?";
          bot.sendMessage(chatId,
            `⚠️ This video will be auto-deleted after <b>6 hours</b>.\n📊 <b>Today's Limit:</b> ${DAILY_VIDEO_LIMIT - (DAILY_VIDEO_LIMIT - (typeof remaining === "number" ? remaining : 0))}/${DAILY_VIDEO_LIMIT} Remaining`,
            { parse_mode: "HTML" }
          ).catch(() => {});
        }

        // Update delivered_to
        FileRecord.updateOne({ _id: record._id }, { $addToSet: { delivered_to: chatId } }).catch(() => {});
      } catch (err) {
        console.error("File delivery error:", err.message);
        bot.sendMessage(chatId, `❌ Could not send file. Please try again.`);
      }
      return;
    }

    // Default: show welcome screen
    await sendWelcome(bot, chatId, msg.from);
  });

  // ─── Welcome screen ──────────────────────────────────────────────────────────
  async function sendWelcome(bot, chatId, from) {
    const name = from?.first_name || "there";
    await bot.sendMessage(chatId,
      `🎓 <b>Welcome to StuBot, ${esc(name)}!</b>\n\n` +
      `Your complete CA Inter lecture platform.\n\n` +
      `📚 Browse lectures by subject & chapter\n` +
      `🎯 Track your daily study progress\n` +
      `🏆 Earn points & unlock premium content\n` +
      `👥 Invite friends to unlock Premium free\n\n` +
      `Tap the button below to get started 👇`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[{ text: "📚 Open StuBot", web_app: { url: WEB_URL } }]],
        },
      }
    );
  }

  // ─── /help ───────────────────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id;
    const adminHelp = isOwner(msg.from?.id)
      ? `\n\n<b>Admin Commands:</b>\n` +
        `/stats — view detailed stats\n` +
        `/batch — start bulk file batch\n` +
        `/done — finish current batch\n` +
        `/cancel — cancel current batch\n` +
        `/myfiles — list your uploaded files\n` +
        `/delete &lt;code&gt; — delete file or batch\n` +
        `/resetlimit &lt;userId&gt; — reset a user's daily limit\n` +
        `/giveaccess &lt;userId&gt; &lt;hours&gt; — grant access\n` +
        `/addadmin &lt;userId&gt; — add admin\n` +
        `/removeadmin &lt;userId&gt; — remove admin\n` +
        `/listadmins — list current admins\n` +
        `/broadcast — broadcast to all users\n` +
        `/rmword &lt;word&gt; — add to remove-words list\n` +
        `/addword &lt;phrase&gt; — add to append-words list\n` +
        `/replaceword 'old' 'new' — add replace rule`
      : "";

    bot.sendMessage(chatId,
      `<b>StuBot Commands</b>\n\n` +
      `/start — open the bot\n` +
      `/help — show this message` +
      adminHelp,
      { parse_mode: "HTML" }
    );
  });

  // ─── /stats ──────────────────────────────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    if (isGroupChat(msg)) return;
    const chatId = msg.chat.id;
    if (!isOwner(msg.from?.id)) return;

    const processing = await bot.sendMessage(chatId, "⏳ Fetching stats...");
    try {
      const r = await fetch(`http://localhost:${PORT}/api/stats`);
      const s = await r.json();
      const uptimeSec = process.uptime();
      const h = Math.floor(uptimeSec / 3600);
      const m = Math.floor((uptimeSec % 3600) / 60);
      const totalFiles = await FileRecord.countDocuments({});
      const totalBatches = await BulkBatch.countDocuments({});

      const text = [
        `📊 <b>STUBOT STATS</b>`,
        ``,
        `👥 USERS`,
        `┣ Total: ${nf(s.users.totalUsers)}`,
        `┗ New This Week: +${nf(s.users.recentUsers)}`,
        ``,
        `📚 CONTENT`,
        `┣ Batches: ${nf(s.content.totalBatches)} (🟢 ${s.content.publicBatches} public · 🔒 ${s.content.privateBatches} private)`,
        `┣ Subjects: ${nf(s.content.totalSubjects)}  |  Chapters: ${nf(s.content.totalChapters)}`,
        `┗ Lectures: ${nf(s.content.totalLectures)}`,
        ``,
        `🔑 ACCESS`,
        `┣ Total Issued: ${nf(s.access.totalAccess)}`,
        `┗ Currently Active: ${nf(s.access.activeAccess)}`,
        ``,
        `👫 REFERRALS`,
        `┣ Total Referrals: ${nf(s.referrals.totalReferrals)}`,
        `┣ Unique Referrers: ${nf(s.referrals.uniqueReferrers)}`,
        `┗ Active Premium Unlocks: ${nf(s.referrals.activePremiums)}`,
        ``,
        `📁 FILE STORE`,
        `┣ Single Files: ${nf(totalFiles)}`,
        `┗ Bulk Batches: ${nf(totalBatches)}`,
        ``,
        `⚙️ SERVER`,
        `┣ Uptime: ${h}h ${m}m`,
        `┣ Node: ${process.version}`,
        `┗ MongoDB: ${mongoose.connection.readyState === 1 ? "🟢 Online" : "🔴 Offline"}`,
        ``,
        `🕐 ${formatIST(new Date())}`,
      ].join("\n");

      await bot.editMessageText(text, { chat_id: chatId, message_id: processing.message_id, parse_mode: "HTML" });
    } catch (err) {
      console.error("Stats error:", err.message);
      bot.editMessageText("❌ Could not fetch stats.", { chat_id: chatId, message_id: processing.message_id });
    }
  });

  // ─── Bulk file batch ─────────────────────────────────────────────────────────
  const bulkSessions = new Map(); // userId → { files: [], timer }

  bot.onText(/\/batch/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    if (bulkSessions.has(userId)) {
      const s = bulkSessions.get(userId);
      clearTimeout(s.timer);
    }
    bulkSessions.set(userId, { files: [], timer: null });
    bot.sendMessage(chatId,
      `📦 <b>Bulk Batch Started</b>\n\nSend me files one by one.\n` +
      `When done, send /done to save.\nSend /cancel to abort.`,
      { parse_mode: "HTML" }
    );
  });

  bot.onText(/\/done/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const session = bulkSessions.get(userId);
    if (!session || !session.files.length) {
      return bot.sendMessage(chatId, `No files in current batch. Send /batch to start.`);
    }

    clearTimeout(session.timer);
    bulkSessions.delete(userId);

    const processing = await bot.sendMessage(chatId, `⏳ Saving batch...`);
    try {
      const batchCode   = await getUniqueBatchCode();
      const storedFiles = [];
      for (const f of session.files) {
        const stored = await saveToStorageChannel(bot, f);
        stored.file_name = cleanFileName(stored.file_name);
        storedFiles.push(stored);
      }
      await BulkBatch.create({ batch_code: batchCode, user_id: userId, files: storedFiles });
      const link = `https://t.me/${BOT_USERNAME}?start=${batchCode}`;
      await bot.deleteMessage(chatId, processing.message_id).catch(() => {});
      const fileList = storedFiles.map((f, i) => `${i + 1}. ${f.file_name}`).join("\n");
      await bot.sendMessage(chatId,
        `✅ <b>Batch saved!</b> ${storedFiles.length} files.\n\n📋 Files:\n${fileList}\n\n🔗 Link:\n<code>${link}</code>`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📥 Get All Files", url: link }]] } }
      );
    } catch (err) {
      console.error("Batch save error:", err.message);
      bot.editMessageText("❌ Batch could not be saved. Please try again.", { chat_id: chatId, message_id: processing.message_id }).catch(() => bot.sendMessage(chatId, "❌ Batch could not be saved. Please try again."));
    }
  });

  bot.onText(/\/cancel/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const userId = msg.from.id;
    const chatId = msg.chat.id;
    const session = bulkSessions.get(userId);
    if (!session) return bot.sendMessage(chatId, `No active batch session.`);
    clearTimeout(session.timer);
    bulkSessions.delete(userId);
    bot.sendMessage(chatId, `❌ Batch cancelled.`);
  });

  // ─── Media handler (for file saving + auto green tick) ───────────────────────
  bot.on("message", async (msg) => {
    if (isGroupChat(msg)) return;
    const userId = msg.from?.id;
    if (!userId) return;

    const fileInfo = extractFileInfo(msg);
    if (!fileInfo) return;

    // Owner: batch mode?
    if (isOwner(userId) && bulkSessions.has(userId)) {
      const session = bulkSessions.get(userId);
      fileInfo.file_name = cleanFileName(fileInfo.file_name);
      session.files.push(fileInfo);
      const chatId = msg.chat.id;
      clearTimeout(session.timer);
      // Auto-save after 10 min of inactivity (so batch saves even if /done is forgotten)
      session.timer = setTimeout(async () => {
        if (!bulkSessions.has(userId)) return;
        bulkSessions.delete(userId);
        try {
          const batchCode   = await getUniqueBatchCode();
          const storedFiles = [];
          for (const f of session.files) {
            const stored = await saveToStorageChannel(bot, f);
            stored.file_name = cleanFileName(stored.file_name);
            storedFiles.push(stored);
          }
          await BulkBatch.create({ batch_code: batchCode, user_id: userId, files: storedFiles });
          const link = `https://t.me/${BOT_USERNAME}?start=${batchCode}`;
          bot.sendMessage(chatId,
            `✅ <b>Batch auto-saved!</b> (${storedFiles.length} files)\n\n🔗 <code>${link}</code>`,
            { parse_mode: "HTML" }
          );
        } catch (err) { console.error("Auto-batch save error:", err.message); }
      }, 10 * 60 * 1000);
      bot.sendMessage(chatId, `✅ File ${session.files.length} added: <code>${esc(fileInfo.file_name)}</code>\nSend /done when finished.`, { parse_mode: "HTML" });
      return;
    }

    // Owner: single file save
    if (isOwner(userId)) {
      try {
        const chatId = msg.chat.id;
        fileInfo.file_name = cleanFileName(fileInfo.file_name);
        const stored = await saveToStorageChannel(bot, fileInfo);
        stored.file_name = fileInfo.file_name;
        const code   = await getUniqueCode();
        await FileRecord.create({ code, ...stored, uploaded_by: userId });
        const link   = `https://t.me/${BOT_USERNAME}?start=${code}`;
        bot.sendMessage(chatId,
          `✅ <b>File saved!</b>\n\n📎 ${esc(stored.file_name)}\n🔗 <code>${link}</code>`,
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📥 Get File", url: link }]] } }
        );

        // Auto green tick: if a session is active, add this lecture automatically
        if (autoLectureSession && autoLectureSession.active) {
          try {
            const lectureNum = autoLectureSession.lectureCount + 1;
            await autoAddLecture({
              batchId:   autoLectureSession.batchId,
              subjectId: autoLectureSession.subjectId,
              chapterId: autoLectureSession.chapterId,
              unitId:    autoLectureSession.unitId,
              name:      `Lecture ${lectureNum}`,
              link,
            });
            autoLectureSession.lectureCount = lectureNum;
            await fetch(`http://localhost:${PORT}/api/auto-lec/status`).catch(() => {});
            const loc = autoLectureSession.unitName
              ? `${autoLectureSession.subjectName} › ${autoLectureSession.chapterName} › ${autoLectureSession.unitName}`
              : `${autoLectureSession.subjectName} › ${autoLectureSession.chapterName}`;
            bot.sendMessage(chatId,
              `✅ <b>Auto-Added!</b> Lecture ${lectureNum}\n📍 ${esc(loc)}`,
              { parse_mode: "HTML" }
            ).catch(() => {});
          } catch (e) { console.error("Auto-add lecture error:", e.message); }
        }
      } catch (err) {
        console.error("Single file save error:", err.message);
        bot.sendMessage(msg.chat.id, `❌ File could not be saved. Please try again.`);
      }
    }
  });

  // ─── /myfiles ────────────────────────────────────────────────────────────────
  const PAGE_SIZE = 10;

  async function sendMyFilesPage(chatId, userId, page, editMsgId = null) {
    try {
      const allFiles   = await FileRecord.find({ uploaded_by: userId }).lean();
      const allBatches = await BulkBatch.find({ user_id: userId }).lean();
      const totalItems = allFiles.length + allBatches.length;
      if (!totalItems) return bot.sendMessage(chatId, `No files or batches uploaded yet.`);

      const totalPages = Math.ceil(totalItems / PAGE_SIZE);
      page = Math.max(0, Math.min(page, totalPages - 1));

      const combined = [
        ...allFiles.map(f   => ({ type: "file",  data: f, created_at: f.created_at })),
        ...allBatches.map(b => ({ type: "batch", data: b, created_at: b.created_at })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      const items  = combined.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const icons  = { document: "📄", photo: "🖼️", video: "🎬", audio: "🎵", voice: "🎤", video_note: "📹" };
      let text     = `📂 <b>My Files</b> — Page ${page + 1}/${totalPages} (${totalItems} total)\n\n`;

      items.forEach((item, i) => {
        const n = page * PAGE_SIZE + i + 1;
        if (item.type === "file") {
          const f = item.data;
          text += `${n}. ${icons[f.file_type] || "📎"} ${esc(f.file_name)}\nhttps://t.me/${BOT_USERNAME}?start=${f.code}\n\n`;
        } else {
          const b = item.data;
          text += `${n}. 📦 Batch (${b.files.length} files)\nhttps://t.me/${BOT_USERNAME}?start=${b.batch_code}\n\n`;
        }
      });

      const buttons = [];
      if (page > 0) buttons.push({ text: "⬅️ Prev", callback_data: `myfiles_page_${page - 1}` });
      if (page < totalPages - 1) buttons.push({ text: "Next ➡️", callback_data: `myfiles_page_${page + 1}` });
      const rm = buttons.length ? { inline_keyboard: [buttons] } : undefined;

      if (editMsgId) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: rm });
      } else {
        await bot.sendMessage(chatId, text, { parse_mode: "HTML", disable_web_page_preview: true, reply_markup: rm });
      }
    } catch (err) { console.error("myfiles error:", err.message); bot.sendMessage(chatId, `Error occurred.`); }
  }

  bot.onText(/\/myfiles/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    await sendMyFilesPage(msg.chat.id, msg.from.id, 0);
  });

  // ─── Callback queries ────────────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const userId = query.from?.id;
    const data   = query.data || "";
    const chatId = query.message?.chat?.id;
    const msgId  = query.message?.message_id;

    if (query.message && isGroupChat(query.message)) return bot.answerCallbackQuery(query.id);
    if (!isOwner(userId)) return bot.answerCallbackQuery(query.id);

    if (data.startsWith("myfiles_page_")) {
      const page = parseInt(data.replace("myfiles_page_", ""), 10);
      await sendMyFilesPage(chatId, userId, page, msgId);
      await bot.answerCallbackQuery(query.id);
    }
  });

  // ─── /delete ─────────────────────────────────────────────────────────────────
  bot.onText(/\/delete (.+)/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const code   = match[1].trim();

    try {
      const record = await FileRecord.findOneAndDelete({ code: { $regex: new RegExp(`^${code}$`, "i") }, uploaded_by: msg.from.id });
      if (record) return bot.sendMessage(chatId, `✅ File deleted successfully!`);

      const batch = await BulkBatch.findOneAndDelete({ batch_code: { $regex: new RegExp(`^${code}$`, "i") }, user_id: msg.from.id });
      if (batch) return bot.sendMessage(chatId, `✅ Batch deleted! (${batch.files.length} files)`);

      bot.sendMessage(chatId, `Code not found or it does not belong to you.`);
    } catch { bot.sendMessage(chatId, `Deletion failed. Please try again.`); }
  });

  // ─── /resetlimit ─────────────────────────────────────────────────────────────
  bot.onText(/\/resetlimit (.+)/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId   = msg.chat.id;
    const targetId = parseInt(match[1].trim(), 10);
    if (!targetId || isNaN(targetId)) return bot.sendMessage(chatId, `Usage: /resetlimit <userId>`);

    try {
      const today = getTodayIST();
      await DailyVideoLimit.findOneAndUpdate({ userId: targetId }, { userId: targetId, count: 0, resetDate: today }, { upsert: true });
      bot.sendMessage(chatId, `✅ Daily video limit reset for user <code>${targetId}</code>.`, { parse_mode: "HTML" });
    } catch { bot.sendMessage(chatId, `Reset failed.`); }
  });

  // ─── /giveaccess ─────────────────────────────────────────────────────────────
  bot.onText(/\/giveaccess(?:\s+(.+))?/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const parts  = (msg.text || "").trim().split(/\s+/);
    const targetId = parts[1];
    const hours    = parseInt(parts[2]);

    if (!targetId || isNaN(parseInt(targetId)) || isNaN(hours) || hours <= 0) {
      return bot.sendMessage(chatId,
        `⚠️ Usage: /giveaccess &lt;user_id&gt; &lt;hours&gt;\n\nExample: <code>/giveaccess 123456789 24</code>`,
        { parse_mode: "HTML" }
      );
    }

    try {
      const uid      = String(parseInt(targetId));
      const existing = await Access.findOne({ userId: uid });
      const now      = new Date();
      const base     = (existing && existing.expiresAt > now) ? existing.expiresAt : now;
      const expiresAt = new Date(base.getTime() + hours * 60 * 60 * 1000);
      await Access.findOneAndUpdate({ userId: uid }, { userId: uid, expiresAt }, { upsert: true, new: true });
      const until = expiresAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
      bot.sendMessage(chatId,
        `✅ <b>Access Granted!</b>\n\nUser: <code>${parseInt(targetId)}</code>\nAdded: <b>${hours} hour${hours !== 1 ? "s" : ""}</b>\nAccess until: <b>${until} IST</b>`,
        { parse_mode: "HTML" }
      );
    } catch (e) { bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
  });

  // ─── Admin management ─────────────────────────────────────────────────────────
  bot.onText(/\/addadmin (.+)/, async (msg, match) => {
    if (isGroupChat(msg) || msg.from?.id !== OWNER_ID) return;
    const chatId    = msg.chat.id;
    const targetStr = match[1].trim();
    const targetId  = parseInt(targetStr);
    if (isNaN(targetId)) return bot.sendMessage(chatId, `Usage: /addadmin <userId>`);

    try {
      await Admin.findOneAndUpdate(
        { adminId: String(targetId) },
        { adminId: String(targetId), addedBy: String(OWNER_ID), addedAt: new Date() },
        { upsert: true }
      );
      adminSet.add(String(targetId));
      bot.sendMessage(chatId, `✅ Admin added: <code>${targetId}</code>`, { parse_mode: "HTML" });
    } catch (e) { bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
  });

  bot.onText(/\/removeadmin (.+)/, async (msg, match) => {
    if (isGroupChat(msg) || msg.from?.id !== OWNER_ID) return;
    const chatId   = msg.chat.id;
    const targetId = parseInt(match[1].trim());
    if (isNaN(targetId)) return bot.sendMessage(chatId, `Usage: /removeadmin <userId>`);

    try {
      await Admin.deleteOne({ adminId: String(targetId) });
      adminSet.delete(String(targetId));
      bot.sendMessage(chatId, `✅ Admin removed: <code>${targetId}</code>`, { parse_mode: "HTML" });
    } catch (e) { bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
  });

  bot.onText(/\/listadmins/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    try {
      const admins = await Admin.find({});
      if (!admins.length) return bot.sendMessage(chatId, `No admins configured.`);
      const list = admins.map(a => `• <code>${a.adminId}</code> — added ${formatIST(a.addedAt)}`).join("\n");
      bot.sendMessage(chatId, `👮 <b>Admins (${admins.length}):</b>\n\n${list}`, { parse_mode: "HTML" });
    } catch (e) { bot.sendMessage(chatId, `❌ Error: ${e.message}`); }
  });

  // ─── /rmword ─────────────────────────────────────────────────────────────────
  bot.onText(/\/rmword(.*)/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const arg    = (match[1] || "").trim();
    if (arg.toLowerCase() === "list") {
      return bot.sendMessage(chatId, rmWords.length ? `📋 Remove list:\n${rmWords.map((w, i) => `${i + 1}. <code>${esc(w)}</code>`).join("\n")}` : `Remove list is empty.`, { parse_mode: "HTML" });
    }
    if (arg.toLowerCase() === "clear") {
      const c = rmWords.length; rmWords = [];
      return bot.sendMessage(chatId, `🗑️ Cleared ${c} word(s).`);
    }
    const quoted = arg.match(/^['"](.+?)['"]$/) || arg.match(/^'(.+?)'$/) || arg.match(/^"(.+?)"$/);
    const word   = (quoted ? quoted[1] : arg.replace(/^['"]|['"]$/g, "")).trim();
    if (!word) return bot.sendMessage(chatId, `Usage: /rmword 'word' | list | clear`);
    const wl = word.toLowerCase();
    if (rmWords.includes(wl)) return bot.sendMessage(chatId, `⚠️ Already in list.`);
    rmWords.push(wl);
    bot.sendMessage(chatId, `✅ Added <code>${esc(word)}</code>. Total: ${rmWords.length}`, { parse_mode: "HTML" });
  });

  // ─── /addword ────────────────────────────────────────────────────────────────
  bot.onText(/\/addword(.*)/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const arg    = (match[1] || "").trim();
    if (arg.toLowerCase() === "list") return bot.sendMessage(chatId, addWords.length ? `📋 Append list:\n${addWords.map((w, i) => `${i + 1}. <code>${esc(w)}</code>`).join("\n")}` : `Append list is empty.`, { parse_mode: "HTML" });
    if (arg.toLowerCase() === "clear") { const c = addWords.length; addWords = []; return bot.sendMessage(chatId, `🗑️ Cleared ${c} phrase(s).`); }
    const removeM = arg.match(/^remove\s+['"]?(.+?)['"]?$/i);
    if (removeM) { const p = removeM[1].trim(); const before = addWords.length; addWords = addWords.filter(w => w.toLowerCase() !== p.toLowerCase()); return bot.sendMessage(chatId, addWords.length < before ? `✅ Removed <code>${esc(p)}</code>.` : `⚠️ Not found.`, { parse_mode: "HTML" }); }
    const quoted = arg.match(/^['"](.+?)['"]$/);
    const phrase = (quoted ? quoted[1] : arg.replace(/^['"]|['"]$/g, "")).trim();
    if (!phrase) return bot.sendMessage(chatId, `Usage: /addword 'phrase' | list | clear | remove 'phrase'`);
    if (addWords.some(w => w.toLowerCase() === phrase.toLowerCase())) return bot.sendMessage(chatId, `⚠️ Already in list.`);
    addWords.push(phrase);
    bot.sendMessage(chatId, `✅ Added <code>${esc(phrase)}</code>. Total: ${addWords.length}`, { parse_mode: "HTML" });
  });

  // ─── /replaceword ────────────────────────────────────────────────────────────
  bot.onText(/\/replaceword(.*)/, async (msg, match) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    const arg    = (match[1] || "").trim();
    if (arg.toLowerCase() === "list") return bot.sendMessage(chatId, replaceWords.length ? `📋 Replace rules:\n${replaceWords.map((r, i) => `${i + 1}. <code>${esc(r.from)}</code> → <code>${esc(r.to)}</code>`).join("\n")}` : `No replace rules.`, { parse_mode: "HTML" });
    if (arg.toLowerCase() === "clear") { const c = replaceWords.length; replaceWords = []; return bot.sendMessage(chatId, `🗑️ Cleared ${c} rule(s).`); }
    const removeM = arg.match(/^remove\s+['"]?(.+?)['"]?$/i);
    if (removeM) { const oldW = removeM[1].trim().toLowerCase(); const before = replaceWords.length; replaceWords = replaceWords.filter(r => r.from.toLowerCase() !== oldW); return bot.sendMessage(chatId, replaceWords.length < before ? `✅ Removed rule for <code>${esc(oldW)}</code>.` : `⚠️ Not found.`, { parse_mode: "HTML" }); }
    const pairM = arg.match(/^['"](.+?)['"]\s+['"](.+?)['"]$/);
    if (!pairM) return bot.sendMessage(chatId, `Usage: /replaceword 'old' 'new' | list | clear`);
    const fromWord = pairM[1].trim(); const toWord = pairM[2].trim();
    const existing = replaceWords.find(r => r.from.toLowerCase() === fromWord.toLowerCase());
    if (existing) { existing.to = toWord; return bot.sendMessage(chatId, `✅ Updated: <code>${esc(fromWord)}</code> → <code>${esc(toWord)}</code>`, { parse_mode: "HTML" }); }
    replaceWords.push({ from: fromWord, to: toWord });
    bot.sendMessage(chatId, `✅ Added rule: <code>${esc(fromWord)}</code> → <code>${esc(toWord)}</code>`, { parse_mode: "HTML" });
  });

  // ─── /broadcast ──────────────────────────────────────────────────────────────
  let broadcastState = null; // { userId, type, content }

  bot.onText(/\/broadcast/, async (msg) => {
    if (isGroupChat(msg) || !isOwner(msg.from?.id)) return;
    const chatId = msg.chat.id;
    broadcastState = { userId: msg.from.id, type: null };
    bot.sendMessage(chatId,
      `📡 <b>Broadcast</b>\n\nSend the message you want to broadcast to all users.\nSupports: text, photo, video, audio, document.`,
      { parse_mode: "HTML" }
    );
  });

  // Handle broadcast content capture
  bot.on("message", async (msg) => {
    if (isGroupChat(msg) || !broadcastState) return;
    if (msg.from?.id !== broadcastState.userId) return;
    if (msg.text && msg.text.startsWith("/")) return;

    const chatId   = msg.chat.id;
    const state    = broadcastState;
    broadcastState = null;

    const allUsers = await User.find({}, { userId: 1 }).lean().catch(() => []);
    if (!allUsers.length) return bot.sendMessage(chatId, `⚠️ No users found.`);

    const progress = await bot.sendMessage(chatId, `📡 Starting broadcast to ${allUsers.length} users...`);
    let sent = 0, failed = 0, blocked = 0;

    for (let i = 0; i < allUsers.length; i++) {
      const targetId = parseInt(allUsers[i].userId, 10);
      if (!targetId) { failed++; continue; }
      try {
        if (msg.text)     await bot.sendMessage(targetId, msg.text, { parse_mode: "HTML" });
        else if (msg.photo)    await bot.sendPhoto(targetId, msg.photo.at(-1).file_id, { caption: msg.caption || "" });
        else if (msg.video)    await bot.sendVideo(targetId, msg.video.file_id, { caption: msg.caption || "" });
        else if (msg.audio)    await bot.sendAudio(targetId, msg.audio.file_id, { caption: msg.caption || "" });
        else if (msg.document) await bot.sendDocument(targetId, msg.document.file_id, { caption: msg.caption || "" });
        sent++;
      } catch (err) {
        const e = err.message || "";
        if (e.includes("blocked") || e.includes("Forbidden") || e.includes("deactivated")) blocked++;
        else failed++;
      }
      if ((i + 1) % 20 === 0 || i === allUsers.length - 1) {
        bot.editMessageText(
          `📡 Broadcasting...\n👥 Total: ${allUsers.length}\n✅ Sent: ${sent}\n🚫 Blocked: ${blocked}\n❌ Failed: ${failed}\n⏳ Progress: ${i + 1}/${allUsers.length}`,
          { chat_id: chatId, message_id: progress.message_id }
        ).catch(() => {});
      }
      if ((i + 1) % 25 === 0) await wait(1000);
    }

    bot.editMessageText(
      `✅ <b>Broadcast Complete!</b>\n\n👥 Total: ${allUsers.length}\n✅ Delivered: ${sent}\n🚫 Blocked: ${blocked}\n❌ Failed: ${failed}`,
      { chat_id: chatId, message_id: progress.message_id, parse_mode: "HTML" }
    ).catch(() => bot.sendMessage(chatId, `✅ Done — Sent: ${sent} | Blocked: ${blocked} | Failed: ${failed}`));
  });

  // ─── Force Join → Premium & Video revocation ──────────────────────────────────
  bot.on("chat_member", async (update) => {
    const newStatus = update.new_chat_member?.status;
    const userId    = update.new_chat_member?.user?.id;
    if (!userId) return;

    const forceJoinChannels = (process.env.FORCE_JOIN_CHANNELS || "")
      .split(",").map(s => s.trim()).filter(Boolean);
    if (!forceJoinChannels.length) return;

    const chatUsername = update.chat?.username ? `@${update.chat.username}` : null;
    const chatIdStr    = String(update.chat?.id);
    const isForced     = forceJoinChannels.some(c =>
      c === chatUsername || c === chatIdStr || c === `-100${chatIdStr}`
    );
    if (!isForced) return;

    if (["left", "kicked"].includes(newStatus)) {
      // User left a required channel → revoke access and delete stored videos

      // Revoke timed access
      await Access.deleteOne({ userId: String(userId) }).catch(() => {});

      // Revoke referral premium
      await ReferralPremium.findOneAndUpdate(
        { userId: String(userId) },
        { expiresAt: new Date(0) } // expire immediately
      ).catch(() => {});

      // Delete stored video messages
      const msgs = userVideoMessages.get(userId);
      if (msgs && msgs.length > 0) {
        for (const { chatId: cid, messageId } of msgs) {
          try { await bot.deleteMessage(cid, messageId); } catch { /* ignore */ }
        }
        userVideoMessages.delete(userId);
      }

      try {
        await bot.sendMessage(userId,
          `⚠️ <b>Access Revoked</b>\n\nYou left a required channel so your access has been removed.\n\nRejoin to restore access. 🔓`,
          { parse_mode: "HTML" }
        );
      } catch { /* user may have blocked bot */ }
    }
  });

  // ─── Periodic premium expiry check ────────────────────────────────────────────
  // Runs every hour — resets expired premium periods so users can start a new cycle
  setInterval(async () => {
    try {
      const expired = await ReferralPremium.find({ expiresAt: { $lt: new Date(), $ne: null } }).catch(() => []);
      for (const rp of expired) {
        if (!rp.unlockedAt) continue; // already reset
        await ReferralPremium.findOneAndUpdate(
          { userId: rp.userId },
          { unlockedAt: null, expiresAt: null, periodStart: new Date() }
        ).catch(() => {});
        // Notify user that premium has expired
        try {
          await bot.sendMessage(parseInt(rp.userId),
            `⏰ <b>Premium Expired</b>\n\nYour referral premium has expired.\n\nInvite ${PREMIUM_REFERRAL_COUNT} more friends to unlock it again for ${PREMIUM_DAYS} days! 🚀`,
            { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "📚 Open StuBot", web_app: { url: WEB_URL } }]] } }
          );
        } catch { /* user may have blocked */ }
      }
    } catch { /* non-fatal */ }
  }, 60 * 60 * 1000);

  bot.on("polling_error", (err) => console.error("Polling error:", err.message));
  process.on("SIGTERM", () => { bot.stopPolling(); mongoose.connection.close(); process.exit(0); });
  process.on("SIGINT",  () => { bot.stopPolling(); mongoose.connection.close(); process.exit(0); });
}

startBot().catch(err => { console.error("Bot startup error:", err.message); process.exit(1); });
