# StuBot — Merge Changelog (Phase 1: Backend)

This repo is `Ca-Inter-lecture--main` (the "Original Bot") used as the base, per instructions.
Everything below was written and syntax-checked (`node -c`) in this pass, but **not run live**
(no Telegram token / MongoDB / network available in the dev sandbox this was built in — see
"What still needs YOUR testing" at the bottom, this matters).

## 1. Payment system — fully removed
- Deleted `/api/pay-request` (UPI screenshot + PAYMENT_GROUP_ID flow).
- Deleted the `buy_` deep-link handler ("Pay Now" button).
- Deleted the `pay_approve_` / `pay_reject_` admin callback branch.
- Removed `UPI_ID` / `PAYMENT_GROUP_ID` env vars from `_env.example`.
- Left the batch `price` field in the schema/data model alone (harmless leftover data,
  not wired to any payment UI anymore) — removing it entirely would touch the admin
  batch-editing UI in `public/index.html`, which is out of scope for this pass.

## 2. Referral Unlock Premium System — built from scratch (new)
New file: `models/ReferralUnlock.js` — MongoDB-only (no SQLite), as required.

- `/premium` command + a new "🔓 Premium" button on the welcome screen.
- Referral only counts once the referred user: starts the bot, is a unique/new user,
  is not a self-referral, AND completes Force Join (join every channel in
  `FORCE_JOIN_CHANNELS`) — verified via a "✅ I've Joined" button.
- Live progress message: `Unlock (n/5)` (`REFERRALS_REQUIRED_FOR_PREMIUM` in `.env`, default 5).
- At 5/5: green congratulations message, 7-day Premium auto-activates, counter resets to 0.
- Premium status shows remaining days (`X Days Left`) and is checked lazily everywhere
  (auto-locks itself once `premiumExpiresAt` passes — no cron job needed).
- "📤 Share Invite" button opens Telegram's native share sheet with the referral link.
- Wired into batch content-gating (`hasPremiumAccess` in `routes/course.js`): while
  Premium is active, the user gets access to ALL premium batches (not just ones they
  were individually added to) — via a small in-memory cache kept in sync with MongoDB
  (`premiumCache` in `models/ReferralUnlock.js`), so the existing synchronous gating
  code didn't need to become async.
- If the user leaves a Force Join channel/group, Premium is revoked immediately
  (see #3 below — same handler).

**Decision made on your behalf:** the *existing* points-based reward system (spend
points to redeem 24h/7-day batch access, `REWARD_CATALOG` in `routes/course.js`) was
left completely alone — it isn't "payment," it's the Points System you asked to keep,
and it already worked. The new Referral Unlock Premium System runs in parallel to it,
not instead of it.

## 3. Bug fix — "Videos Deleted" message
The base bot (`Ca-Inter-lecture--main`) had no force-join-leave-deletes-video feature
at all — this whole flow was ported over from your bot (`CA_Found-Lecture--main`),
**with the bug already fixed in the port**: the notification message now only sends
if a video was actually found and deleted, instead of firing unconditionally.
New handler: `bot.on("chat_member", ...)` near the bottom of `server.js`. It also
revokes Premium in the same pass (see #2).

## 4. Save Button delay — fixed
`/done` used to save batch files to the storage channel one-by-one in a `for` loop
(`await` inside the loop) — an N-file batch took N sequential Telegram round-trips.
Now saves in parallel chunks of 5, which should feel close to instant for typical
batch sizes while staying under Telegram's flood limits.

## 5. Points System / Daily Lecture Limit — verified, not rebuilt
Both already existed in the base bot and were working:
- Points: `getPointsBreakdown()` in `routes/course.js`, MongoDB-backed via the
  `Referral` / `RewardRedemption` collections.
- Daily limit: `DAILY_VIDEO_LIMIT = 10`, resets on the IST calendar day, remaining
  count shown after every delivery — but this only applied to the bot's file-store
  deep-link flow, not to lectures opened inside the WebApp.
- **Added this pass:** `GET /api/lecture-limit/:userId` and
  `POST /api/lecture-limit/:userId/consume` in `routes/course.js`, reusing the same
  counter, so the WebApp can enforce "10 lectures/day" there too. **The frontend does
  not call these endpoints yet** — that's a Phase 2 (frontend) task.

## 6. Branding — backend only, so far
- `package.json` name → `stubot`.
- Telegram menu button text → "Open StuBot".
- `_env.example` cleaned up (MongoDB URI placeholder now says `stubot`).
- **NOT done:** the actual welcome-screen redesign, logo swap, and any UI text in
  `public/index.html` (4,458 lines) — see below.

## What's explicitly NOT in this pass (Phase 2 — frontend)
- `public/index.html` was not touched at all: welcome screen redesign, StuBot logo/
  branding, "Add Zone"/custom sections from your bot's frontend, Premium section UI,
  and wiring the two new `/api/lecture-limit/*` endpoints into lecture playback.
- "Auto Green Tick" — I could not find this feature's code in either backend repo, so
  I couldn't verify what it does. If it's a UI badge, it's likely a frontend-only
  thing living in `index.html` — please point me to it (or describe exactly what it
  should look like/do) so it isn't guessed at.

## What still needs YOUR testing
I could not run this bot (no live Telegram token, no MongoDB, no network access in my
sandbox), so nothing here has been tested against real Telegram/Mongo traffic — only
`node -c` syntax-checked. Please test on a staging bot/DB before pointing this at
production, specifically:
- The full referral → force-join → 5/5 → premium unlock loop end-to-end.
- Premium revocation when leaving a force-join channel.
- `/done` batch save with a realistic file count.
- That `mongoose.model('DailyVideoLimit')` resolves correctly (it's registered in
  `server.js` before `routes/course.js` is required, which should be safe, but is
  worth confirming with a real run).

---

# Phase 1.5 — SQLite fully removed, WebApp "Verifying" screen fixed

## SQLite removed entirely — MongoDB only
Every `db.*` call (158 of them across `server.js` and `routes/course.js`) has been
replaced with direct Mongoose calls. `sqlite-manager.js` is deleted, `better-sqlite3`
is out of `package.json`, and nothing imports it anymore.

What that involved, since it wasn't just a find/replace:
- **~20 redundant cache-writes deleted outright** — every `db.batch.upsert(batch.toObject())`
  came immediately after `await batch.save()`, which already wrote to MongoDB. The
  SQLite copy was pure write-amplification; removing it needed no replacement.
- **Auto-Lecture-Session made real.** This previously lived in SQLite only — the
  "MongoDB backup" code that existed for it referenced a model
  (`mongoose.models.AutoLecSession`) that was never actually registered anywhere, so
  it silently did nothing. There's now a real `AutoLecSession` model in
  `routes/course.js` and this feature actually persists to Mongo.
- **SpinToken given a real Mongo model.** Same situation as above — SQLite-only,
  no Mongo equivalent existed at all. Added one, mirroring `AdToken`'s shape
  (including the TTL index that auto-expires old tokens).
- **Points-redeem and Spin-claim double-spend protection re-implemented.** The
  original code relied on SQLite being *synchronous* — "no `await` between the
  balance check and the write" is what made it impossible for two rapid clicks to
  both pass the check. MongoDB is inherently async, so that guarantee doesn't carry
  over automatically. Added a small per-user mutex (`withUserLock` in
  `routes/course.js`) that serializes redeem/spin-claim requests for the *same*
  user — different users are unaffected, but the same user's rapid double-click
  can no longer double-spend. Worth a deliberate test: rapid-fire the redeem/spin
  endpoints for one user and confirm only one succeeds.
- **Admin `/stats` dashboard rebuilt on Mongo aggregation** (`countDocuments`,
  `aggregate` for sums, `distinct` for unique counts) instead of raw SQL.

## WebApp "Verifying" screen — explained and fixed
This wasn't a bug I introduced with new code — it's a screen that was **already
built into the Original Bot's frontend** (`public/index.html`'s `checkForceJoin()`
+ the `/api/force-join/*` routes), just dormant because `FORCE_JOIN_CHANNELS` was
always empty in testing. The Referral Unlock System reused that same env var for
its own "did the referred user join?" check — so configuring it for referrals was
*also* silently switching on the whole-app gate.

**Fix:** split into two separate env vars (see `_env.example`):
- `FORCE_JOIN_CHANNELS` — controls the WebApp-wide gate only. Leave empty unless
  you specifically want the whole mini-app locked behind Force Join.
- `REFERRAL_FORCE_JOIN_CHANNELS` — controls only whether a referral counts. Setting
  this does **not** touch the WebApp gate anymore.

If you want the same channels to require both, set both vars to the same value —
but they're independent now, so the Referral Unlock System configuration alone
won't surprise you with the WebApp gate again.

## Still not done
- Frontend (`public/index.html`) itself — still untouched. Welcome screen redesign,
  StuBot branding/logo, and wiring the `/api/lecture-limit/*` endpoints into actual
  lecture playback are all Phase 2.
- "Auto Green Tick" — still unclear what this feature is; nothing in either
  backend repo referenced it. Please describe/show it so it isn't guessed at.
- This SQLite removal is large (115+43 call sites) and, like Phase 1, has **not
  been run against a live bot/Mongo** — please test thoroughly on staging,
  especially the redeem/spin double-spend fix and the Auto-Lecture-Session feature
  (both got new code paths, not just a mechanical swap).

---

# Phase 2 (partial) — Frontend: Referral Unlock UI, dead payment code removed

## What's done in the WebApp (`public/index.html`)
- **Payment Modal fully removed** — the entire "Complete Payment" modal (QR code,
  UPI ID, coupon input, UTR number, screenshot upload) and every JS function that
  only existed to support it (`buyBatch`, `closePayModal`, `applyCoupon`,
  `submitPayment`, `copyUpi`, `handleSsUpload`, `validateUtr`, `_updatePayQr`) —
  all deleted. This was genuinely dead code once the payment backend was removed
  in Phase 1, so removing it also satisfies the "no dead code" requirement.
- **Batch cards now show the Referral Unlock status**, per the spec:
  `(Ref: 5/5) • (5D Left)` while active, `(Locked)` while not — in small red/pink
  text under the batch title, exactly where the price used to show. New backend
  endpoint powers this: `GET /api/premium/status/:userId`.
- **"Buy ₹price" button → "🔓 Unlock Free" button.** Tapping it deep-links to the
  bot's `/premium` command (`https://t.me/<bot>?start=premium`) via
  `tg.openTelegramLink`, rather than duplicating the whole progress/share/
  force-join UI a second time inside the WebApp — the bot side already has all of
  that fully built and working (see Phase 1). This keeps a single source of truth
  for the unlock flow instead of two UIs that could drift out of sync.
- Premium-batch access gating itself (locked by default, auto-unlocks ALL premium
  batches at 5/5, re-locks after 7 days) was already wired in Phase 1's
  `hasPremiumAccess()` — this phase only added the visible status text/button.

## Auto Green Tick — found it, it already exists
This is the **Watched Lecture** feature already built into the Original Bot's
frontend (`markLectureWatched` / `toggleLectureWatched` / the `.lec-watched-check`
corner badge that turns green once a lecture is opened). It was already fully
backed by MongoDB after Phase 1's SQLite removal (`/api/watched/:userId`). Nothing
needed to change here — flagging this so it's not mistaken for a missing feature.

## Still not done (be aware before calling this "complete")
- **Welcome screen assets/message from Repository B** — not yet pulled in. I have
  Repo B's logo (base64 JPEG) and welcome text identified but have not yet spliced
  them into Repo A's welcome screen markup. This needs a careful, separate pass —
  the welcome screen is a large, style-sensitive block and deserves its own review
  rather than a rushed edit at the end of an already-long session.
- **StuBot branding pass on the frontend itself** (page `<title>`, any hardcoded
  bot name strings in `index.html`) — only the backend (menu button, package.json)
  was rebranded so far.
- **"Create Batch" admin form** still has the old `price` input field. It's
  inert now (nothing reads it for gating), but it's a leftover UI element I did
  not remove — flagging as a minor cleanup item.
- As with every phase: **not run against a live bot/WebApp** — the new
  `openReferralPremium()` deep-link and the status-text rendering should be
  smoke-tested in an actual Telegram WebApp session before shipping.

---

# Phase 2 (continued) — Welcome screen branding from Repository B

- App title, the loading/"Verifying" splash screen, and the WebApp header now
  say **StuBot** instead of the old "EduBot" (found and fixed 3 hardcoded spots
  in `public/index.html`).
- The Force Join gate screen's icon is now Repository B's actual logo image
  (pulled from Repo B's frontend and embedded the same way Repo B did it),
  replacing the old plain 📚 emoji placeholder — this is the branding asset swap
  requested.
- The bot's Telegram `/start` welcome message now opens with **"🎓 Welcome to
  StuBot!"**, keeping Repository A's existing message structure (invite link,
  points mention, buttons) rather than replacing it wholesale.

## Known remaining gaps (still true, not fixed this pass)
- "Create Batch" admin form still has the old inert `price` field — cosmetic
  leftover, not wired to anything anymore.
- No favicon/PWA icon swap was needed — Repo A's `index.html` doesn't define one,
  so there was nothing to replace there.
- Still not run against a live bot/WebApp session — please test the visual
  changes (logo renders correctly, title bar shows StuBot on all devices) on
  staging before shipping.

---

# Phase 3 — Referral Unlock pivoted to per-batch, WebApp-only (major rework)

Based on direct feedback, the Referral Unlock System was **redesigned from
scratch** — the earlier "global 5-referrals unlocks ALL premium batches" model
and its bot-chat `/premium` command are gone. Replaced with:

## New model: per-batch, admin-configurable
- Each premium batch now has its own `referralsRequired` count, set by the admin
  right in the Create/Edit Batch form (appears under the Premium checkbox,
  replacing the old inert `price` field — the price field wasn't wired to
  anything since payment was removed anyway).
- Progress, unlock, and expiry are tracked **per (user, batch) pair** — unlocking
  Batch A's referral requirement does NOT unlock Batch B. New model:
  `BatchReferralUnlock` in `models/ReferralUnlock.js` (replaces the old global
  `ReferralUnlock` model).
- Referral links now encode which batch they're for:
  `t.me/<bot>?start=ref_<referrerId>_<batchId>` (old link format without a
  batchId still works for the unrelated Points System referral tracking, it
  just doesn't count toward any batch unlock).

## Bot-chat "Premium" UI — completely removed
- No more "🔓 Premium" button on the `/start` welcome message.
- No more `/premium` command.
- The bot's only remaining role in this flow: receive a referred friend via the
  deep link, gate them behind Force Join, and silently credit the referrer's
  progress for that specific batch. It still sends a one-line DM when a batch
  unlocks or a referral counts (e.g. "🎁 New Valid Referral! BatchName: (3/5)")
  since that seemed reasonable to keep — say if you'd rather it stayed
  completely silent.

## Everything else — now inside the WebApp
- **Batch card**: premium batches show a small status line under the title —
  orange `(Ref: n/X)` while counting, green `(Xd Left)` once unlocked, red
  `(Locked)` once expired/not yet unlocked.
- **Unlock button** (red, replacing the old "Buy ₹price" button) opens a new
  in-WebApp modal (`runlockModal`) — no more deep-linking out to bot chat. The
  modal shows: how many referrals are needed, live progress, a light-blue
  explanation box ("only counts once your friend completes Force Join"), an
  italic light-blue "Click Here to unlock →" link, and a red "Share Invite &
  Unlock" button that opens Telegram's native share sheet with the batch-
  specific link.
- **Tapping a locked premium batch card** now opens this same Unlock modal
  directly, instead of a dead-end toast message.
- New endpoint powering all of this: `GET /api/batch-referral/status/:userId/:batchId`
  (replaces the old global `/api/premium/status/:userId`).

## Also cleaned up in this pass
- Removed the leftover `price` UI field from both Create Batch and Edit Batch
  forms (was inert since Phase 1's payment removal) — replaced with the new
  Referrals Required field in both places.
- Removed the now-unused global `REFERRALS_REQUIRED_FOR_PREMIUM` env var
  entirely — there's no global default anymore, it's 100% per-batch, admin-set,
  defaulting to 5 if left blank when creating a batch.

## Still true from before (unchanged this pass)
- Force Join channel-leave still revokes access — now revokes ALL of a user's
  currently-unlocked batches at once (not just one), since leaving the channel
  means they no longer qualify for any of them.
- 7-day unlock duration is still fixed in `server.js`
  (`REFERRAL_PREMIUM_DURATION_MS`) — let me know if this should also become
  admin-configurable per batch alongside the referral count.
- **Still not run against a live bot/WebApp.** This was a significant rework of
  the core unlock flow — please test end-to-end on staging before shipping:
  create a premium batch with e.g. 2 referrals required, refer 2 test accounts
  through Force Join, confirm the batch unlocks and the status line updates,
  then confirm it locks again after leaving a Force Join channel.

---

# Phase 3 — Pivoted to per-batch, WebApp-only Referral Unlock

Based on direct feedback, the Referral Unlock System was reworked from a single
global "5 referrals unlocks everything" model into a **per-batch** model, and
moved entirely into the WebApp (nothing in the bot's chat welcome message anymore).

## What changed
- **Removed from bot chat:** the "🔓 Premium" button on `/start` and the whole
  `/premium` command are gone. The bot's only remaining role in this system is
  receiving a referred friend via deep link and gating them behind Force Join —
  the actual unlock UI never lived in chat again after this.
- **Referrals-required is now per-batch, admin-set.** `Batch.referralsRequired`
  (default 5) — set in the Create Batch form (replaces the old inert Price
  field, which matches how the payment system's removal made price meaningless
  anyway) and editable per-batch afterward.
- **New data model:** `BatchReferralUnlock` (userId + batchId + progress +
  unlocked + expiresAt) replaces the old global `ReferralUnlock`. A user can
  have DIFFERENT unlock states for different batches at the same time — unlocking
  Batch A does not touch Batch B.
- **Referral links now carry the batch**: `t.me/<bot>?start=ref_<referrerId>_<batchId>`
  instead of just `ref_<referrerId>`. Old-style links (no batchId) still work for
  the unrelated Points System referral tracking, they just don't count toward
  any batch unlock.
- **New in-WebApp Unlock modal** (`runlockModal`) — opens when tapping a locked
  premium batch's card or the batch itself. Shows: "Refer X to unlock", live
  progress in **orange**, a light-blue explainer about Force Join, an italic
  light-blue "Click Here to unlock →" link, and a red "Share Invite & Unlock"
  button that opens Telegram's native share sheet with the batch-specific link.
- **Batch card status line** now shows orange `(Ref: n/X)`, green `(Xd Left)`
  once unlocked, or red `(Locked)` — colors as specified.
- **Tapping a locked batch** now opens the Unlock modal directly instead of a
  dead-end toast.
- Leaving a Force Join channel now revokes **every** batch the user had
  unlocked via referrals (not just one) — `revokeAllBatchPremiumForUser`.
- `_env.example` updated: no more global `REFERRALS_REQUIRED_FOR_PREMIUM` var —
  that's admin/per-batch now. `REFERRAL_FORCE_JOIN_CHANNELS` still controls
  Force Join for this system, still decoupled from the WebApp-wide gate.

## Still true from before (unchanged in this pass)
- Payment system fully removed, SQLite fully removed, verifying-screen fix,
  Videos-Deleted bug fix, Save-button fix, Points/Daily-Limit/Green-Tick already
  working, StuBot branding — all still in place, none of this was touched.

## Please test before shipping
This is a real architecture change (global → per-batch), not a cosmetic tweak:
- Create a premium batch with e.g. `referralsRequired: 2`, get a real referral
  link from the Unlock modal, and walk a second test account through the whole
  loop (start → force join → verify) to confirm the batch actually unlocks and
  the modal's live progress updates.
- Confirm a batch's unlock doesn't leak into another batch's status.
- Confirm leaving a Force Join channel revokes ALL unlocked batches for that user.

---

# Phase 3 — Referral Unlock pivoted to per-batch, entirely in the WebApp

This phase undid the previous global "5 referrals unlocks ALL premium batches"
design and rebuilt it per the corrected spec: **each premium batch has its own
referral requirement, set by the admin per batch, and the whole unlock flow
lives inside the WebApp — not the bot's chat/welcome message.**

## What changed
- **Removed from bot chat entirely:** the "🔓 Premium" welcome-screen button and
  the `/premium` command. The bot's only remaining role in this system is
  receiving a referred friend via the deep link and gating them behind Force
  Join — it no longer shows any progress/unlock UI itself.
- **`Batch.referralsRequired`** — new field (default 5). Admin sets this per
  batch in the Create/Edit Batch form, right where the old (unused) Price field
  used to be, exactly as described: tick "Premium" → a "👥 Referrals Required"
  field appears → fill in a number → create as normal.
- **Referral link now carries the batch**: `t.me/<bot>?start=ref_<uid>_<batchId>`
  instead of a bot-wide link. A referral only ever counts toward the specific
  batch it was shared for.
- **New in-WebApp Unlock modal** (opens when tapping a locked batch's "Unlock"
  button, or the batch card itself): shows "Refer X friends to unlock", live
  orange `(Ref: n/X)` progress, a light-blue Force-Join explanation box, an
  italic light-blue "Click Here to unlock →" link, and a red "Share Invite &
  Unlock" button that opens Telegram's native share sheet with the batch-
  specific link.
- **Batch card status line**: orange `(Ref: n/X)` while counting, green
  `(Xd Left)` once unlocked, red `(Locked)` once expired/never unlocked —
  colors exactly as specified.
- **Backend model rebuilt per-batch**: `BatchReferralUnlock` (was the global
  `ReferralUnlock`) — one row per (user, batch) pair, its own progress array,
  its own 7-day expiry. `hasPremiumAccess()` in `routes/course.js` now checks
  the specific batch's unlock state, not a global "user has premium" flag.
  New endpoint: `GET /api/batch-referral/status/:userId/:batchId`.
- **Force-Join channel leave** now revokes ALL of a user's active per-batch
  unlocks at once (they could have several running concurrently), not a single
  global flag.
- Tapping a locked premium batch card now opens the Unlock modal directly
  instead of a dead-end "buy from admin" toast.

## Still true from earlier phases (unaffected by this pivot)
- Payment/UPI/Coupon system: still fully removed.
- SQLite: still fully removed, MongoDB only.
- Points System, Daily Lecture Limit, Auto Green Tick (Watched Lecture badge):
  unaffected, still working as documented in Phase 1/2.
- StuBot branding (title, verifying screen, logo, welcome text): unaffected.

## Not yet tested
As with every phase — this has **not been run against a live bot/WebApp
session**. Specifically worth testing on staging before shipping:
- Creating a premium batch with a custom "Referrals Required" value and
  confirming it's actually enforced (not just displayed).
- The full loop: open locked batch → Unlock modal → share link → friend joins
  + force-joins → referrer's card updates to the new (Ref: n/X) → hits target →
  batch unlocks for 7 days → card shows green (Xd Left) → expires → back to
  (Locked).
- Leaving a Force Join channel while multiple batches are unlocked — confirm
  all of them lock, not just one.

---

# Phase 4 — Complete payment-system purge (Amount field, Coupon system, price field)

Triggered by a direct callout: the Amount(₹) field in the admin's Create/Edit
Batch modal was already replaced with "Referrals Required" in Phase 3, but a
full audit found **more payment-adjacent code still lingering** that Phase 3
didn't touch. All of it is now gone.

## Removed completely (backend + frontend + schema)
- **`price` field** — deleted from `Batch` schema (`models/Course.js`), from
  both the create and edit batch API handlers, and from the Rewards
  "eligible batches" API response. The one remaining UI spot that still showed
  a stray `₹price` (the Points-redemption batch picker in the Rewards tab) now
  just shows the subject count.
- **Entire Coupon system** — this was independent of the payment modal deleted
  in Phase 2 and had survived unnoticed: its own MongoDB model (`Coupon`), 5
  API routes (`/coupons` CRUD + `/coupons/validate`), a whole admin "🎟 Coupons"
  tab with its own form (code/discount%/expiry/apply-to-batches) and list UI,
  and 4 JS functions (`adminLoadCoupons`, `adminCreateCoupon`,
  `adminToggleCoupon`, `adminDeleteCoupon`). All deleted — model, routes, tab
  button, tab content, and JS functions.
- **Orphaned Payment Modal CSS** — the modal HTML itself was deleted in
  Phase 2, but ~30 CSS rules for it (`.pay-overlay`, `.pay-qr-*`, `.pay-upi-*`,
  `.pay-coupon-*`, `.pay-amount*`, etc.) were still sitting in the stylesheet
  unused. Removed all of them **except** `.pay-submit-btn` — kept because the
  new Referral Unlock modal (Phase 3) reuses that class for its own "Share
  Invite & Unlock" button, and it's a legitimate general-purpose button style,
  not something payment-specific.
- Also dropped the now-empty `coupons` stat from the admin dashboard's
  `/api/stats` response (nothing in the frontend was reading it).

## Confirmed still correct (unaffected by this cleanup)
- The Points-redemption system (`RewardRedemption`, `BatchRewardAccess`,
  spend-points-for-batch-access) is **not** payment and was intentionally left
  alone — it's the "Points System" the project explicitly asked to keep.
- Full grep sweep across `server.js`, `routes/course.js`, and
  `public/index.html` for "price", "amount", "coupon", "upi" (case-insensitive)
  now returns nothing except one explanatory code comment.

## Not yet tested
Still no live run. Please specifically verify on staging: creating/editing a
premium batch (confirm no leftover price input appears, "Referrals Required"
saves and is respected), and that the admin panel's remaining tabs all still
work correctly with the Coupons tab gone (tab index shift).

---

# Phase 5 — Green "Congratulations" popup, in the WebApp itself

Confirmed: everything described in this request was already built in Phase 3
(per-batch Premium select in the same Create/Edit Batch modal, red "Unlock"
button, Telegram's native share/forward picker via Share Invite, Force-Join-
gated referral counting, 7-day unlock, `(Ref: n/X)` / `(Xd Left)` status under
the batch). One piece was missing: the celebration was only a bot-chat DM, not
an in-WebApp popup. Added now:

- `toast()` now accepts an optional custom duration (existing 2-arg calls are
  unaffected — defaults to the same 2.8s as before).
- The status loader now detects the exact moment a batch flips from
  locked → unlocked for the current user, and shows a green, ~4-second popup:
  **"🎉 Congratulations! You unlocked <batch name> for 7 days!"**
- Since that flip can happen in the background (a friend's Force Join gets
  verified while you're just browsing, not necessarily right when you open the
  app), added a 20-second background poll (only while the tab/app is visible)
  so the popup reliably fires without needing a manual refresh.
- The bot-chat DM notification (Phase 3) still also fires, as a backup in case
  the WebApp isn't open at all at that moment — belt and suspenders, not either/or.

Still not run live — please confirm the popup timing/wording feels right and
that the 20s poll doesn't feel wasteful on slow connections; interval is easy
to tune in `_loadBatchReferralStatuses`'s `setInterval` call if needed.

---

# Phase 6 — Rebuilt against a fresh repo upload + deployment-verification markers

You reported the deployed WebApp still showed the old Price(₹) field / no
Premium section after deploying + restarting. A fresh repo was uploaded to
rule out any confusion about which file was live — it turned out to be
byte-identical to the original base I'd already been working from, so this
phase re-verified every change against that fresh copy from scratch (full
syntax check + a stale-reference grep sweep across every file) rather than
assuming the prior work was still correct, and fixed what that audit found:

## Bugs found and fixed in this audit
- **`/stats` admin bot command still said `SQLite: ✅ Active`** — genuinely
  stale, leftover from before SQLite was removed. This wouldn't have caused
  your symptom (it's just bot-chat text), but it's exactly the kind of stale
  marker that erodes confidence when you're trying to tell old vs new code
  apart — fixed to say `Database: MongoDB only`.
- **`localStorage`/`sessionStorage` keys were still `edubot_*`** — harmless
  functionally (just internal storage keys), but renamed to `stubot_*` for
  consistency, since they were an obvious leftover of the old name.

## Deployment-verification markers (new)
Since the deployed app not reflecting new code was the actual problem last
time, three ways to confirm a deploy is really live now:
1. **View Page Source** on your deployed WebApp URL — the very first line
   should be an HTML comment: `<!-- STUBOT_BUILD: referral-unlock-v1
   (2026-07-24) -->`. If you don't see this exact comment, the browser/CDN/
   Telegram is still serving an old cached file — the fix is on the hosting/
   caching side, not the code.
2. **Browser console** (or Telegram's WebView inspector if available) — logs
   `StuBot build: referral-unlock-v1` on every page load.
3. **Backend**: visit `<your-app-url>/health` after deploying — the JSON
   response now includes `"build": "referral-unlock-v1"`.
4. **Admin Panel** itself shows a small `build: referral-unlock-v1` tag next
   to the "Admin Panel" title (admin-only, easy to eyeball without devtools).

If you deploy this and STILL don't see these markers anywhere, that's a very
useful, concrete signal — it confirms the issue is 100% on the hosting/
deploy/cache side (wrong branch, build failing silently, CDN cache, Telegram
WebApp cache) rather than anything in the code, and narrows down exactly
where to look next.

## Everything from Phases 1-5 re-verified present in this build
Full syntax check across every file (`node -c` on all `.js` files, extracted
and checked all 5 inline `<script>` blocks in `index.html`) plus a targeted
grep sweep confirmed still true: no `price`/`amount`/`coupon`/`upi` anywhere
except explanatory comments, `referralsRequired` field on the Batch schema,
`BatchReferralUnlock` model wired into both `server.js` and
`routes/course.js`, the `/api/batch-referral/status/:userId/:batchId`
endpoint, the in-WebApp Unlock modal (`#runlockModal`), the decoupled
`REFERRAL_FORCE_JOIN_CHANNELS` env var, and StuBot branding with zero
remaining "EduBot" mentions.

---

# Phase 7 — WEB_URL auto-detected on Render, better missing-env error

Root cause of the "Missing env: BOT_TOKEN, MONGO_URI, WEB_URL, OWNER_ID"
deploy crash: `WEB_URL` genuinely wasn't set in the Render environment vars
(confirmed from the uploaded env file — every other required var was there).
Two fixes:

1. **`WEB_URL` now auto-falls-back to Render's own `RENDER_EXTERNAL_URL`**
   (a variable Render injects into every web service automatically — no
   action needed on your part). You only need to set `WEB_URL` by hand on
   non-Render hosts, or to override it for a custom domain. Updated
   `render.yaml` and `_env.example` to reflect this — `WEB_URL` is no longer
   in the "you must set this" list for Render deploys.
2. **The missing-env-var check is now dynamic** — it used to always print
   all 4 var names regardless of which were actually missing, which is why
   this took an extra round-trip to diagnose. It now lists exactly which
   var(s) are absent.
