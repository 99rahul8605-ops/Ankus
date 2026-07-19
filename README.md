# StuBot — CA Inter Lecture Bot

A Telegram Mini App bot for CA Inter lecture delivery with referral premium system, force join, daily limits, spin wheel, and more.

## Setup

### 1. Clone & Install
```bash
npm install
```

### 2. Environment Variables
Copy `_env.example` to `.env` and fill in:
```
BOT_TOKEN        — Your Telegram Bot token (from @BotFather)
MONGO_URI        — MongoDB Atlas connection string
WEB_URL          — Your Render/Railway app URL (e.g. https://stubot.onrender.com)
OWNER_ID         — Your Telegram user ID (get from @userinfobot)
STORAGE_CHANNEL_ID — Private channel ID where the bot stores files
```

### 3. Deploy on Render
- Connect your GitHub repo
- Build command: `npm install`
- Start command: `node server.js`
- Add all env vars from `_env.example`

## Features
- 📚 Batch / Subject / Chapter / Lecture management
- 🔗 Referral system: 5 referrals = 7-day premium unlock
- 🎡 Spin wheel: earn points by watching ads
- 🏆 Rewards system: redeem points for access
- 📺 Daily lecture limit (configurable)
- 🔒 Force Join: must join channels to access content
- 👑 Multi-admin support
- 📁 File Store: store and share files via bot links
- 📢 Announcements system

## Bot Commands
- `/start` — Start the bot / open the web app
- `/addadmin <user_id>` — Add admin (owner only)
- `/removeadmin <user_id>` — Remove admin (owner only)
- `/giveaccess <user_id> <hours>` — Grant access (owner only)
- `/stats` — Bot statistics (owner only)
