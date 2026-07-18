# TrigifyX Server

A small, self-contained Node.js (Express) backend for TrigifyX. It replaces the
pure-frontend "post straight to Telegram" approach so the **Telegram bot token
stays 100% server-side** and every capture request is authenticated with the
per-user `accessToken`.

## What it does

- `POST /api/submit` — accepts a form submission `{ accessToken, fields, page }`
  from the TrigifyX capture script running on a user's site.
- Validates the `accessToken` and resolves the destination chat id from
  Firebase (`pub/<accessToken>/telegram`) using the **Admin SDK** (server-trusted,
  no public DB reads).
- Forwards the submission to Telegram via the Bot API.
- `GET /health` — liveness check.

## Setup

```bash
cd server
npm install
cp .env.example .env   # then edit with your real values
npm start
```

### Required env vars

| Var | Purpose |
|-----|---------|
| `TELEGRAM_BOT_TOKEN` | @BotFather token for @TrigifyXbot |
| `PORT` | listen port (default 3000) |
| `ALLOWED_ORIGINS` | CORS allow-list, comma-separated (`*` = any) |
| `FIREBASE_SERVICE_ACCOUNT` | path to a service-account JSON, **or** the `FIREBASE_*` inline vars |
| `FIREBASE_DATABASE_URL` | only if using a non-default RTDB |

### Firebase service account

In the Firebase console: Project Settings → Service accounts → Generate new
private key. Save the JSON and point `FIREBASE_SERVICE_ACCOUNT` at it (gitignored).

The server only reads `pub/<token>/telegram` and `pub/<token>/uid`, which matches
the RTDB rules (Admin SDK bypasses rules anyway since it's privileged).

## Security notes

- The bot token is never sent to the browser.
- The user's snippet contains only the `accessToken` (un-guessable, 72 hex chars).
- A stolen snippet can only deliver to the owner's own linked Telegram — it
  cannot read or change the destination (that requires the authenticated app).
- Rate-limit `/api/submit` at your host (e.g. nginx / Cloud Run) for production.

## Deploy

Runs on any Node host (Render, Railway, Fly.io, Cloud Run, a VPS…). Set the env
vars, run `npm install && npm start`, and point the TrigifyX snippet's endpoint
at `https://your-server.example.com/api/submit`.
