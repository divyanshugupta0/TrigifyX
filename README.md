# TrigifyX

Connect any HTML form on any website to your Telegram account via **@TrigifyXbot**.
Users sign up, generate an API key, link their Telegram, and paste one script tag.
Every form submission is delivered to their Telegram instantly.

## Architecture — 100% frontend (no backend server)

- **Static site** (`public/`) — served from Netlify (or any static host). Auth + user
  data via **Firebase Realtime Database web SDK**.
- **Capture script** (`public/js/trigifyx-capture.js`) — embedded on users' sites. On
  form submit it **posts straight to the Telegram Bot API** from the browser using the
  bot token injected from deploy env vars. **No backend required.**
- **Telegram bot** (`bot/server.py`, optional) — a 24/7 Python bot that answers
  `/start`, `/myid`, `/help` so users can discover their chat id. It is NOT needed for
  submission delivery; it only helps users.

### Why no backend?
The bot token is a public token (anyone can get it from @BotFather). For a personal/
self-use bot it is safe to use it client-side. Submissions go directly:
`browser → api.telegram.org → user's Telegram`. Nothing is stored on a server.

## Configuration

### Firebase (frontend)
The site reads `window.__ENV__.firebase` from `public/js/firebase-init.js` (your real
config is hardcoded there) and `public/js/config.js` (gitignored, optional override).
If Firebase isn't reachable it runs in **demo mode** (localStorage) so the UI works.

### Bot token (injected, never committed)
`public/js/env-injected.js` (gitignored) sets `window.__ENV__.botToken`. Populate it
from your deploy env var `TELEGRAM_BOT_TOKEN`:
- **Netlify:** Site settings → Environment variables → `TELEGRAM_BOT_TOKEN`, then use
  **Snippet injection** (post-processing) to insert
  `window.__ENV__.botToken = "..."` — or paste it into `env-injected.js` for local testing.
- The dashboard reads this token and embeds it into the generated snippet as
  `window.TRIGIFYX.token`.

### Telegram bot (optional helper)
1. @BotFather → create bot → copy token → set as `TELEGRAM_BOT_TOKEN`.
2. Deploy `bot/server.py` (Python) 24/7 so users can `/start` to get their chat id.
3. Users send `/start` to @TrigifyXbot, copy the numeric chat id, and paste it into the
   site as their Telegram destination.

## Deploy

**Netlify (frontend only):**
```
netlify deploy --prod
```
`netlify.toml` publishes `public/`. That's the whole site — no functions, no server.

**Python bot (optional, separate host):**
```
cd bot && pip install -r requirements.txt && python server.py
```
Set `TELEGRAM_BOT_TOKEN` (and `WEBHOOK_URL` for webhook mode) on that host.

## Local dev
```
# Serve the static site (any static server works)
npx serve public        # or: python -m http.server 8080 --directory public
```
For local testing, put your token in `public/js/env-injected.js`.

## How the embeddable script works
`public/js/trigifyx-capture.js` scans for `<form>` elements, serializes fields on submit,
and calls `https://api.telegram.org/bot<token>/sendMessage` directly (plain text).
Submissions are queued in `localStorage` and retried with backoff, so a transient
network failure does not lose data.
