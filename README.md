# StuBot — CA Inter Lectures

Telegram Mini App bot for CA Inter Lectures.

## Required Environment Variables

| Variable | Description |
|---|---|
| `BOT_TOKEN` | From @BotFather |
| `MONGO_URI` | MongoDB Atlas connection string (db: `stubot_inter`) |
| `OWNER_ID` | Your Telegram user ID (get from @userinfobot) |

## Optional Environment Variables

| Variable | Description |
|---|---|
| `WEB_URL` | Auto-detected on Render/Railway. Set manually elsewhere. |
| `STORAGE_CHANNEL_ID` | Private channel for permanent file storage |
| `FORCE_JOIN_CHANNELS` | Comma-separated channel IDs (force-join gate) |

## Deploy on Render (Free)
1. Push this repo to GitHub
2. **New Web Service** on [render.com](https://render.com) → connect repo
3. Set env vars in Render dashboard
4. Deploy!

## Deploy on Railway
1. Push to GitHub
2. New project on [railway.app](https://railway.app) → connect repo
3. Set env vars → Deploy

## Bot Commands (Owner Only)

| Command | Description |
|---|---|
| `/start` | Welcome + Open App button |
| `/bulk` | Bulk upload mode |
| `/myfiles` | View saved files |
| `/delete <code>` | Delete a file |
| `/rmword '<word>'` | Auto-remove word from file names |
| `/broadcast <text>` | Send to all users |
| `/broadcast --pin <text>` | Send + pin message |
| Reply to media + `/broadcast` | Broadcast media |

## After Changing Bots — Re-migrate File IDs
```bash
BOT_TOKEN=xxx MONGO_URI=yyy STORAGE_CHANNEL_ID=zzz OWNER_ID=www node migrate_files.js
```
