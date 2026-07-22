# TrigifyX Cloudflare Worker

An edge-deployed backend for TrigifyX. The TrigifyX **frontend can be hosted on
any platform** (Netlify, Vercel, GitHub Pages, a VPS, etc.) — it just needs to
POST form submissions to this Worker's URL. The Worker authenticates the request
with the per-user `accessToken`, looks up the destination chat id in Firebase,
and delivers the message to Telegram.

This is functionally equivalent to `server/server.js` (the Node backend) but
runs on Cloudflare's edge: zero servers to manage, global latency, and the
Telegram bot token stays 100% in Worker secrets.

## Endpoints

- `POST /api/submit` — body `{ accessToken, fields, page }`
- `GET /health` — `{ ok: true }`
- `GET /wakeup` — returns all linked Telegram chat ids from Firebase `tg/`

## Deploy

```bash
cd worker
npm install -g wrangler        # or: npx wrangler
wrangler login

# Set secrets (do NOT commit these):
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put FIREBASE_DB_URL
# optional:
wrangler secret put ALLOWED_ORIGINS   # e.g. https://yoursite.com  (default "*")

wrangler deploy
```

After deploy you get a URL like `https://trigifyx-worker.<sub>.workers.dev`.
Set that as `apiBase` in the TrigifyX frontend (`public/js/env-injected.js`):

```js
window.__ENV__.apiBase = "https://trigifyx-worker.<sub>.workers.dev";
```

The dashboard snippet will then embed that endpoint and the capture script will
route submissions through the Worker.

## How it resolves the chat id

It reads `pub/<accessToken>/telegram` from Firebase Realtime Database via the
**REST API** (the existing public `.read: true` rule). No Firebase Admin SDK or
service account is needed in the Worker.

## Security

- Bot token is a Worker secret — never sent to the browser.
- The user's snippet contains only `accessToken` + the Worker endpoint.
- A stolen snippet can only deliver to the owner's own linked Telegram; it
  cannot read/change the destination (that requires the authenticated app).
- Rate-limit `/api/submit` (Cloudflare rate-limiting / WAF) for production.
