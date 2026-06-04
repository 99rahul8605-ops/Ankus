const TelegramBot = require("node-telegram-bot-api");
const mongoose = require("mongoose");
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;
const OWNER_ID = parseInt(process.env.OWNER_ID || "0");

// ── Auto-detect WEB_URL (Render/Railway pe manually dalne ki zarurat nahi) ───
// Priority: .env WEB_URL → Render automatic URL → Railway automatic URL
const WEB_URL = process.env.WEB_URL
  || process.env.RENDER_EXTERNAL_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);

let BOT_USERNAME = "";

if (!TOKEN || !MONGO_URI || !OWNER_ID) {
  console.error("Missing env: BOT_TOKEN, MONGO_URI, OWNER_ID are required.");
  process.exit(1);
}
if (!WEB_URL) {
  console.warn("WEB_URL not set and not on Render/Railway — web app button will not work.");
}

function isOwner(userId) { return userId === OWNER_ID; }

// ── Admin Schema ──────────────────────────────────────────────────────────────
const adminSchema = new mongoose.Schema({
  userId:  { type: String, required: true, unique: true },
  addedBy: { type: String },
  addedAt: { type: Date, default: Date.now },
  note:    { type: String, default: '' },
});
const Admin = mongoose.model("Admin", adminSchema);

let _adminCache = new Set();
let _adminCacheLoaded = false;

async function loadAdminCache() {
  const admins = await Admin.find({});
  _adminCache = new Set(admins.map(a => String(a.userId)));
  _adminCacheLoaded = true;
}
async function isAdmin(userId) {
  if (isOwner(userId)) return true;
  if (!_adminCacheLoaded) await loadAdminCache();
  return _adminCache.has(String(userId));
}
async function addAdmin(userId, addedBy, note = '') {
  await Admin.findOneAndUpdate(
    { userId: String(userId) },
    { userId: String(userId), addedBy: String(addedBy), addedAt: new Date(), note },
    { upsert: true, new: true }
  );
  _adminCache.add(String(userId));
}
async function removeAdmin(userId) {
  await Admin.deleteOne({ userId: String(userId) });
  _adminCache.delete(String(userId));
}

mongoose.connect(MONGO_URI)
  .then(async () => { console.log("MongoDB connected"); await loadAdminCache(); })
  .catch((err) => { console.error("MongoDB error:", err.message); process.exit(1); });

// ── Schemas ───────────────────────────────────────────────────────────────────
const accessSchema = new mongoose.Schema({
  userId:    { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
});
accessSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const Access = mongoose.model("Access", accessSchema);

const fileSchema = new mongoose.Schema({
  code:        { type: String, required: true, unique: true, index: true },
  file_id:     { type: String, required: true },
  file_type:   { type: String, required: true },
  file_name:   { type: String, default: "file" },
  uploaded_by: { type: Number },
  expires_at:  { type: Date, default: null },
  delivered_to:[ { type: Number } ],
  created_at:  { type: Date, default: Date.now },
});
fileSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expires_at: { $type: "date" } } });
const FileRecord = mongoose.model("FileRecord", fileSchema);

const bulkBatchSchema = new mongoose.Schema({
  batch_code: { type: String, required: true, unique: true, index: true },
  user_id:    { type: Number, required: true },
  files: [{
    file_id:   { type: String, required: true },
    file_type: { type: String, required: true },
    file_name: { type: String, default: "file" },
  }],
  created_at: { type: Date, default: Date.now },
});
const BulkBatch = mongoose.model("BulkBatch", bulkBatchSchema);

const pendingDeleteSchema = new mongoose.Schema({
  chat_id:    { type: Number, required: true },
  message_id: { type: Number, required: true },
  delete_at:  { type: Date, required: true },
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

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/health", (req, res) => res.status(200).json({
  status: "ok", uptime: process.uptime(),
  webUrl: WEB_URL || "not set",
  mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected",
}));

app.get("/api/config", async (req, res) => {
  const forceJoinChannels = (process.env.FORCE_JOIN_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  const admins = await Admin.find({}).select('userId').lean();
  const adminIds = [OWNER_ID, ...admins.map(a => parseInt(a.userId))].filter(Boolean);
  res.json({ ownerId: OWNER_ID, adminIds, botUsername: BOT_USERNAME || '', forceJoinRequired: forceJoinChannels.length > 0 });
});

app.use("/api", require("./routes/course"));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Server running on port ${PORT} | Web URL: ${WEB_URL || "NOT SET"}`));

// ── Helpers ───────────────────────────────────────────────────────────────────
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
  const caption = msg.caption || null;
  if (msg.document)   return { file_id: msg.document.file_id,  file_type: "document",   file_name: msg.document.file_name || "document", caption };
  if (msg.photo)      return { file_id: msg.photo[msg.photo.length-1].file_id, file_type: "photo", file_name: "photo.jpg", caption };
  if (msg.video)      return { file_id: msg.video.file_id,      file_type: "video",      file_name: msg.video.file_name || "video.mp4", caption };
  if (msg.audio)      return { file_id: msg.audio.file_id,      file_type: "audio",      file_name: msg.audio.file_name || "audio.mp3", caption };
  if (msg.voice)      return { file_id: msg.voice.file_id,      file_type: "voice",      file_name: "voice.ogg", caption };
  if (msg.video_note) return { file_id: msg.video_note.file_id, file_type: "video_note", file_name: "video_note.mp4", caption: null };
  return null;
}
async function sendFile(bot, chatId, record, userId = null) {
  const caption = `📎 ${record.file_name}`;
  const protect = !(userId && await isAdmin(userId));
  switch (record.file_type) {
    case "photo":      return bot.sendPhoto(chatId, record.file_id, { caption });
    case "video":      return bot.sendVideo(chatId, record.file_id, { caption, ...(protect && { protect_content: true }) });
    case "audio":      return bot.sendAudio(chatId, record.file_id, { caption });
    case "voice":      return bot.sendVoice(chatId, record.file_id, { caption });
    case "video_note": return bot.sendVideoNote(chatId, record.file_id, { ...(protect && { protect_content: true }) });
    default:           return bot.sendDocument(chatId, record.file_id, { caption });
  }
}

const bulkSessions = new Map();
const BULK_TIMEOUT_MS = 5 * 60 * 1000;
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scheduleDelete(bot, chatId, messageId, deleteAt) {
  await PendingDelete.create({ chat_id: chatId, message_id: messageId, delete_at: deleteAt });
  const delay = Math.max(0, deleteAt - Date.now());
  setTimeout(async () => {
    try { await bot.deleteMessage(chatId, messageId); } catch (_) {}
    await PendingDelete.deleteOne({ chat_id: chatId, message_id: messageId }).catch(() => {});
  }, delay);
}
async function recoverPendingDeletes(bot) {
  const pending = await PendingDelete.find({});
  for (const p of pending) {
    const delay = Math.max(0, new Date(p.delete_at) - Date.now());
    setTimeout(async () => {
      try { await bot.deleteMessage(p.chat_id, p.message_id); } catch (_) {}
      await PendingDelete.deleteOne({ _id: p._id }).catch(() => {});
    }, delay);
  }
}
function getForceJoinChannelIds() {
  return (process.env.FORCE_JOIN_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ── Bot Startup ───────────────────────────────────────────────────────────────
async function startBot() {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates?offset=-1&timeout=0`, { signal: AbortSignal.timeout(10000) });
  } catch (_) {}

  let bot;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      bot = new TelegramBot(TOKEN, {
        polling: {
          interval: 2000, autoStart: false,
          params: { timeout: 30, allowed_updates: JSON.stringify(["message", "callback_query", "chat_member"]) },
        },
      });
      await bot.getMe();
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      await wait(5000 * attempt);
    }
  }

  bot.startPolling();
  const me = await bot.getMe();
  BOT_USERNAME = me.username;
  console.log(`Bot started: @${BOT_USERNAME}`);

  // ── Menu button (web app) ─────────────────────────────────────────────────
  if (WEB_URL) {
    try {
      await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menu_button: { type: "web_app", text: "Open StuBot", web_app: { url: WEB_URL } } }),
      });
    } catch (_) {}
  }

  // ── setMyCommands ─────────────────────────────────────────────────────────
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/setMyCommands`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [{ command: "start", description: "Start the bot" }],
        scope: { type: "all_private_chats" },
      }),
    });
    await fetch(`https://api.telegram.org/bot${TOKEN}/setMyCommands`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        commands: [
          { command: "start",        description: "Start the bot" },
          { command: "addadmin",     description: "Add admin — /addadmin 123456789" },
          { command: "removeadmin",  description: "Remove admin — /removeadmin 123456789" },
          { command: "listadmins",   description: "List all admins" },
          { command: "grantaccess",  description: "Give access — /grantaccess 123456789 48" },
          { command: "revokeaccess", description: "Remove access — /revokeaccess 123456789" },
          { command: "checkaccess",  description: "Check access — /checkaccess 123456789" },
          { command: "bulk",         description: "Start bulk file upload" },
          { command: "myfiles",      description: "View my uploaded files" },
          { command: "done",         description: "Finish bulk upload" },
          { command: "cancel",       description: "Cancel current operation" },
        ],
        scope: { type: "chat", chat_id: OWNER_ID },
      }),
    });
    console.log("Commands set");
  } catch (err) { console.warn("setMyCommands error:", err.message); }

  await recoverPendingDeletes(bot);

  // ── chat_member: access revoke on channel leave ───────────────────────────
  bot.on("chat_member", async (update) => {
    try {
      const newMember = update.new_chat_member;
      const chatId = update.chat?.id;
      if (!newMember || !chatId) return;
      const userId = newMember.user?.id;
      const status = newMember.status;
      if (!userId) return;
      const forceIds = getForceJoinChannelIds();
      const chatIdStr = String(chatId);
      const chatUsername = update.chat?.username ? "@" + update.chat.username : null;
      const isForceChannel = forceIds.some(id =>
        id === chatIdStr || (chatUsername && id.toLowerCase() === chatUsername.toLowerCase())
      );
      if (!isForceChannel) return;
      if (status === "left" || status === "kicked" || status === "banned") {
        const deleted = await Access.deleteOne({ userId: String(userId) });
        if (deleted.deletedCount > 0) {
          console.log(`Access revoked: user ${userId} left channel ${chatIdStr}`);
          bot.sendMessage(userId,
            `⚠️ *Access Revoked!*\n\nAapne required channel chhod diya, isliye access hataya gaya.\n\nRejoin karke wapas ad dekh ke access pao. 🔒`,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
      }
    } catch (err) { console.error("chat_member error:", err.message); }
  });

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const param = match[1].trim();
    const admin = userId && await isAdmin(userId);
    const isNewUser = userId ? !(await User.findOne({ userId: String(userId) }).catch(() => null)) : false;
    if (userId) {
      User.findOneAndUpdate(
        { userId: String(userId) },
        { userId: String(userId), firstName: msg.from.first_name || "", lastName: msg.from.last_name || "", username: msg.from.username || "", lastSeen: new Date() },
        { upsert: true, new: true }
      ).catch(() => {});
    }

    if (param) {
      if (param.startsWith("ref_")) {
        const referrerId = param.replace("ref_", "");
        const referredId = String(msg.from?.id || "");
        const webBtn = WEB_URL ? [[{ text: "📚 Browse Lectures", web_app: { url: WEB_URL } }]] : [];
        bot.sendMessage(chatId,
          `👋 Hello ${msg.from.first_name}!\n\nTap the button below to browse all lectures! 📚`,
          { reply_markup: { inline_keyboard: webBtn } }
        );
        if (referrerId && referrerId !== String(userId)) {
          try {
            const rr = await fetch(`http://localhost:${PORT}/api/refer/record`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ referrerId, referredId, isNewUser }),
            });
            const rd = await rr.json();
            if (rd.isNew) {
              const sr = await fetch(`http://localhost:${PORT}/api/refer/stats/${referrerId}`);
              const stats = await sr.json();
              const name = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');
              bot.sendMessage(parseInt(referrerId),
                `🎉 <b>New Referral!</b>\n\n${name} joined via your referral link!\n\n⭐ Total: <b>${stats.points}</b>\n\n<i>Jab woh saare required channels join kar le, tumhe 8 hours ka bonus access milega! 🕐</i>`,
                { parse_mode: 'HTML' }
              ).catch(() => {});
            }
          } catch (_) {}
        }
        return;
      }
      if (param.startsWith("B")) {
        try {
          const batch = await BulkBatch.findOne({ batch_code: param });
          if (!batch) return bot.sendMessage(chatId, `File not found.`);
          for (const f of batch.files) await sendFile(bot, chatId, f, userId);
          return;
        } catch (_) { return bot.sendMessage(chatId, `Error. Please try again.`); }
      }
      try {
        const record = await FileRecord.findOne({ code: { $regex: new RegExp(`^${param}$`, "i") } });
        if (!record) return bot.sendMessage(chatId, `File not found.`);
        const isVideo = record.file_type === "video" || record.file_type === "video_note";
        if (isVideo && record.delivered_to.includes(chatId))
          return bot.sendMessage(chatId, `⚠️ This video was already delivered. It auto-deletes in 24h.`);
        const sentMsg = await sendFile(bot, chatId, record, userId);
        if (isVideo) {
          const deleteAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
          await scheduleDelete(bot, chatId, sentMsg.message_id, deleteAt);
          await FileRecord.updateOne({ _id: record._id }, { $addToSet: { delivered_to: chatId } });
          setTimeout(async () => {
            await FileRecord.updateOne({ _id: record._id }, { $pull: { delivered_to: chatId } }).catch(() => {});
          }, 24 * 60 * 60 * 1000);
          bot.sendMessage(chatId, `⚠️ This video will auto-delete from your DM after 24 hours.`);
        }
      } catch (_) { bot.sendMessage(chatId, `Error. Please try again.`); }
      return;
    }

    const ownerCmds = isOwner(userId)
      ? `\n/addadmin &lt;id&gt; — Admin banao\n/removeadmin &lt;id&gt; — Hatao\n/listadmins — List dekho`
      : '';
    const adminCmds = admin
      ? `\n\n👑 <b>Admin Commands:</b>\n/grantaccess &lt;id&gt; &lt;hours&gt; — Access do\n/revokeaccess &lt;id&gt; — Access hatao\n/checkaccess &lt;id&gt; — Status dekho\n/bulk — Bulk upload\n/myfiles — Meri files${ownerCmds}`
      : '';
    const webBtn = WEB_URL ? [[{ text: "📚 Browse Lectures", web_app: { url: WEB_URL } }]] : [];
    bot.sendMessage(chatId,
      `👋 Hello ${msg.from.first_name}!\n\nTap the button below to browse all lectures! 📚${adminCmds}`,
      { parse_mode: 'HTML', reply_markup: { inline_keyboard: webBtn } }
    );
  });

  // ── /addadmin ─────────────────────────────────────────────────────────────
  bot.onText(/\/addadmin(?:\s+(\d+))?(?:\s+(.*))?/, async (msg, match) => {
    if (!isOwner(msg.from?.id)) return bot.sendMessage(msg.chat.id, `❌ Owner only.`);
    const targetId = match[1];
    if (!targetId) return bot.sendMessage(msg.chat.id, `Usage: /addadmin <user_id>`);
    if (String(targetId) === String(OWNER_ID)) return bot.sendMessage(msg.chat.id, `Owner ko admin add nahi karna.`);
    await addAdmin(targetId, msg.from.id, match[2] || '');
    bot.sendMessage(msg.chat.id, `✅ <code>${targetId}</code> is now admin!`, { parse_mode: 'HTML' });
    bot.sendMessage(parseInt(targetId), `🎉 Aapko <b>Admin</b> bana diya gaya!\n\n/start karo commands dekhne ke liye.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  // ── /removeadmin ──────────────────────────────────────────────────────────
  bot.onText(/\/removeadmin(?:\s+(\d+))?/, async (msg, match) => {
    if (!isOwner(msg.from?.id)) return bot.sendMessage(msg.chat.id, `❌ Owner only.`);
    const targetId = match[1];
    if (!targetId) return bot.sendMessage(msg.chat.id, `Usage: /removeadmin <user_id>`);
    await removeAdmin(targetId);
    bot.sendMessage(msg.chat.id, `✅ <code>${targetId}</code> removed from admin.`, { parse_mode: 'HTML' });
    bot.sendMessage(parseInt(targetId), `ℹ️ Admin access removed.`).catch(() => {});
  });

  // ── /listadmins ───────────────────────────────────────────────────────────
  bot.onText(/\/listadmins/, async (msg) => {
    if (!isOwner(msg.from?.id)) return bot.sendMessage(msg.chat.id, `❌ Owner only.`);
    const admins = await Admin.find({}).sort({ addedAt: -1 });
    if (!admins.length) return bot.sendMessage(msg.chat.id, `No admins yet.\n\nUse /addadmin <user_id>`);
    const list = admins.map((a, i) => `${i+1}. <code>${a.userId}</code>${a.note ? ` — ${a.note}` : ''}`).join('\n');
    bot.sendMessage(msg.chat.id, `👑 <b>Admins (${admins.length}):</b>\n\n${list}`, { parse_mode: 'HTML' });
  });

  // ── /grantaccess ──────────────────────────────────────────────────────────
  bot.onText(/\/grantaccess(?:\s+(\d+))?(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from?.id;
    if (!userId || !(await isAdmin(userId))) return bot.sendMessage(msg.chat.id, `❌ Admins only.`);
    const targetId = match[1];
    const hours = parseInt(match[2] || '24');
    if (!targetId) return bot.sendMessage(msg.chat.id, `Usage: /grantaccess <user_id> <hours>`);
    if (isNaN(hours) || hours < 1 || hours > 720) return bot.sendMessage(msg.chat.id, `Hours must be 1–720.`);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    await Access.findOneAndUpdate({ userId: String(targetId) }, { userId: String(targetId), expiresAt }, { upsert: true, new: true });
    const expStr = expiresAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    bot.sendMessage(msg.chat.id, `✅ <code>${targetId}</code> → <b>${hours}h access</b>\nExpires: ${expStr} IST`, { parse_mode: 'HTML' });
    bot.sendMessage(parseInt(targetId), `🎉 <b>Access Granted!</b>\n\nAapko <b>${hours} hours</b> ka access diya gaya!\nExpires: ${expStr} IST\n\n📚 /start karo.`, { parse_mode: 'HTML' }).catch(() => {});
  });

  // ── /revokeaccess ─────────────────────────────────────────────────────────
  bot.onText(/\/revokeaccess(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from?.id;
    if (!userId || !(await isAdmin(userId))) return bot.sendMessage(msg.chat.id, `❌ Admins only.`);
    const targetId = match[1];
    if (!targetId) return bot.sendMessage(msg.chat.id, `Usage: /revokeaccess <user_id>`);
    const del = await Access.deleteOne({ userId: String(targetId) });
    if (del.deletedCount > 0) {
      bot.sendMessage(msg.chat.id, `✅ Access revoked for <code>${targetId}</code>`, { parse_mode: 'HTML' });
      bot.sendMessage(parseInt(targetId), `⚠️ Your access has been revoked.`).catch(() => {});
    } else {
      bot.sendMessage(msg.chat.id, `ℹ️ <code>${targetId}</code> had no active access.`, { parse_mode: 'HTML' });
    }
  });

  // ── /checkaccess ──────────────────────────────────────────────────────────
  bot.onText(/\/checkaccess(?:\s+(\d+))?/, async (msg, match) => {
    const userId = msg.from?.id;
    if (!userId || !(await isAdmin(userId))) return bot.sendMessage(msg.chat.id, `❌ Admins only.`);
    const targetId = match[1];
    if (!targetId) return bot.sendMessage(msg.chat.id, `Usage: /checkaccess <user_id>`);
    const record = await Access.findOne({ userId: String(targetId) });
    if (!record || record.expiresAt < new Date()) {
      bot.sendMessage(msg.chat.id, `🔒 <code>${targetId}</code>: <b>No access</b>`, { parse_mode: 'HTML' });
    } else {
      const ms = record.expiresAt - new Date();
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      const expStr = record.expiresAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      bot.sendMessage(msg.chat.id, `✅ <code>${targetId}</code>: <b>Active</b>\n⏳ ${h}h ${m}m remaining\n📅 ${expStr} IST`, { parse_mode: 'HTML' });
    }
  });

  // ── /bulk ─────────────────────────────────────────────────────────────────
  bot.onText(/\/bulk/, async (msg) => {
    const userId = msg.from?.id;
    if (!userId || !(await isAdmin(userId))) return;
    const chatId = msg.chat.id;
    if (bulkSessions.has(userId)) return bot.sendMessage(chatId, `⚠️ Bulk mode already active!\n/done or /cancel`);
    const timer = setTimeout(async () => {
      if (bulkSessions.has(userId)) {
        bulkSessions.delete(userId);
        bot.sendMessage(chatId, `⏰ Bulk session timed out.`).catch(() => {});
      }
    }, BULK_TIMEOUT_MS);
    bulkSessions.set(userId, { files: [], chatId, timer });
    bot.sendMessage(chatId, `📦 Bulk mode ON!\n\nSend files → /done (finish) / /cancel`);
  });

  // ── /done ─────────────────────────────────────────────────────────────────
  bot.onText(/\/done/, async (msg) => {
    const userId = msg.from?.id;
    if (!userId || !(await isAdmin(userId))) return;
    const chatId = msg.chat.id;
    const session = bulkSessions.get(userId);
    if (!session) return bot.sendMessage(chatId, `No active bulk session.`);
    if (!session.files.length) return bot.sendMessage(chatId, `⚠️ No files sent!`);
    clearTimeout(session.timer);
    bulkSessions.delete(userId);
    const p = await bot.sendMessage(chatId, `⏳ Saving...`);
    try {
      const batchCode = await getUniqueBatchCode();
      await BulkBatch.create({ batch_code: batchCode, user_id: userId, files: session.files });
      const link = `https://t.me/${BOT_USERNAME}?start=${batchCode}`;
      await bot.deleteMessage(chatId, p.message_id);
      const fileList = session.files.map((f, i) => `${i+1}. ${f.file_name}`).join("\n");
      bot.sendMessage(chatId,
        `✅ Batch ready! ${session.files.length} files\n\n📋 Files:\n${fileList}\n\n🔗 Link:\n<code>${link}</code>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "📥 Get Files", url: link }]] } }
      );
    } catch (_) { bot.editMessageText(`Error.`, { chat_id: chatId, message_id: p.message_id }).catch(() => {}); }
  });

  // ── /cancel ───────────────────────────────────────────────────────────────
  bot.onText(/\/cancel/, async (msg) => {
    const userId = msg.from?.id;
    if (!userId || !(await isAdmin(userId))) return;
    const session = bulkSessions.get(userId);
    if (!session) return bot.sendMessage(msg.chat.id, `No active session.`);
    clearTimeout(session.timer);
    bulkSessions.delete(userId);
    bot.sendMessage(msg.chat.id, `❌ Cancelled.${session.files.length ? ` (${session.files.length} files discarded)` : ""}`);
  });

  // ── /myfiles ──────────────────────────────────────────────────────────────
  const PAGE_SIZE = 10;
  async function sendMyFilesPage(chatId, userId, page, editMsgId = null) {
    try {
      const allFiles   = await FileRecord.find({ uploaded_by: userId });
      const allBatches = await BulkBatch.find({ user_id: userId });
      const combined = [
        ...allFiles.map(f => ({ type: "file", data: f, created_at: f.created_at })),
        ...allBatches.map(b => ({ type: "batch", data: b, created_at: b.created_at })),
      ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      if (!combined.length) return bot.sendMessage(chatId, `No files yet.`);
      const totalPages = Math.ceil(combined.length / PAGE_SIZE);
      page = Math.max(0, Math.min(page, totalPages - 1));
      const pageItems = combined.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const emoji = { document: "📄", photo: "🖼️", video: "🎬", audio: "🎵", voice: "🎤", video_note: "📹" };
      let text = `📂 My Files — ${page+1}/${totalPages} (${combined.length} total)\n\n`;
      pageItems.forEach((item, i) => {
        const n = page * PAGE_SIZE + i + 1;
        if (item.type === "file") {
          text += `${n}. ${emoji[item.data.file_type]||"📎"} ${item.data.file_name}\nhttps://t.me/${BOT_USERNAME}?start=${item.data.code}\n\n`;
        } else {
          text += `${n}. 📦 Batch (${item.data.files.length} files)\nhttps://t.me/${BOT_USERNAME}?start=${item.data.batch_code}\n\n`;
        }
      });
      const buttons = [];
      if (page > 0)              buttons.push({ text: "⬅️ Prev", callback_data: `myfiles_page_${page-1}` });
      if (page < totalPages - 1) buttons.push({ text: "Next ➡️", callback_data: `myfiles_page_${page+1}` });
      const rm = buttons.length ? { inline_keyboard: [buttons] } : undefined;
      if (editMsgId) {
        await bot.editMessageText(text, { chat_id: chatId, message_id: editMsgId, disable_web_page_preview: true, reply_markup: rm });
      } else {
        await bot.sendMessage(chatId, text, { disable_web_page_preview: true, reply_markup: rm });
      }
    } catch (_) { bot.sendMessage(chatId, `Error.`); }
  }

  bot.onText(/\/myfiles/, async (msg) => {
    const userId = msg.from?.id;
    if (!userId || !(await isAdmin(userId))) return;
    await sendMyFilesPage(msg.chat.id, userId, 0);
  });

  bot.on("callback_query", async (query) => {
    const userId = query.from?.id;
    const data = query.data || "";
    if (data.startsWith("myfiles_page_") && userId && await isAdmin(userId)) {
      const page = parseInt(data.replace("myfiles_page_", ""), 10);
      await sendMyFilesPage(query.message.chat.id, userId, page, query.message.message_id);
    }
    await bot.answerCallbackQuery(query.id).catch(() => {});
  });

  // ── File messages ─────────────────────────────────────────────────────────
  bot.on("message", async (msg) => {
    const userId = msg.from?.id;
    if (!userId || !(await isAdmin(userId))) return;
    if (msg.text && msg.text.startsWith("/")) return;
    const chatId = msg.chat.id;
    const fileInfo = extractFileInfo(msg);
    if (!fileInfo) return;
    const session = bulkSessions.get(userId);
    if (session) {
      session.files.push({ file_id: fileInfo.file_id, file_type: fileInfo.file_type, file_name: fileInfo.file_name });
      return bot.sendMessage(chatId, `✅ File ${session.files.length}: ${fileInfo.file_name}\nSend more or /done`);
    }
    try {
      const code = await getUniqueCode();
      await FileRecord.create({ code, file_id: fileInfo.file_id, file_type: fileInfo.file_type, file_name: fileInfo.file_name, uploaded_by: userId });
      const link = `https://t.me/${BOT_USERNAME}?start=${code}`;
      bot.sendMessage(chatId,
        `✅ Saved!\n📎 <b>${fileInfo.file_name}</b>\n🔗 <code>${link}</code>`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: "📥 Get File", url: link }]] } }
      );
    } catch (_) { bot.sendMessage(chatId, `Error saving file.`); }
  });
}

startBot().catch(err => { console.error("Bot startup failed:", err.message); process.exit(1); });
