# TrigifyX

Connect any HTML form on any website to your Telegram account via **@TrigifyXbot**.
Users sign up, get an **access token**, link their Telegram chat id, drop one script
tag on their site, and every form submission is delivered to their Telegram instantly.

TrigifyX is built around a **zero-secret frontend + secure Cloudflare Worker** model:
the browser never sees the Telegram bot token, and form data is forwarded by a Worker
that resolves the destination server-side.

---

## Architecture

```
User's website
  └─ <script src="trigifyx-capture.js">  (embedded snippet)
        └─ POST /api/submit  ──►  Cloudflare Worker (trigifyx-worker)
                                      │  resolves accessToken → pub/{token}/telegram
                                      │  validates origin (siteUrl) → security checks
                                      └─► Telegram Bot API  ──►  Owner's Telegram
```

### Components

| Piece | Location | Role |
|-------|----------|------|
| **Static site / dashboard** | `public/` | Signup, Telegram link, site setup, install snippet, live stats. Auth + data via **Firebase Realtime Database** web SDK. |
| **Capture script** | `public/js/trigifyx-capture.js` (served by the Worker at `/trigifyx-capture.js`) | Scans for `<form>`s, serializes fields on submit, and `POST`s to the Worker (not directly to Telegram). Offline queue + retry. |
| **Cloudflare Worker** | `worker/worker.js` | The secure backend. Resolves the chat id from Firebase, validates the request origin, applies exposure/block rules, and sends to Telegram using the **server-side bot token**. |
| **Telegram bot** | `bot/server.py` | Optional 24/7 Python helper that answers `/start`, `/myid`, `/help` and persists the user's chat id to Firebase. |

### Why this design (no bot token in the browser)
The capture script only ever sends `accessToken + fields + page` to the Worker. The
Worker holds the Telegram bot token as a Cloudflare secret and is the only thing that
talks to `api.telegram.org`. The Telegram destination (chat id) is resolved
**server-side** from `pub/{token}/telegram`, never embedded in the page source.

---

## Security system

The Worker enforces several layers of protection so a leaked access token cannot be
abused to spam the owner or other users.

### 1. Access token (not an API key) in the snippet
The install snippet embeds a random 72-hex **`accessToken`** generated client-side
(`accessToken()` in `app.js`). It maps to the owner's chat id via
`pub/{token}/telegram`. The token is unguessable and can be **regenerated** from the
dashboard, which instantly invalidates the old one.

### 2. Server-side origin validation (anti-exposure)
Each token can have one or more registered **sites** (origins only, e.g.
`https://yoursite.com`). The dashboard lets a user register **multiple sites per
account** — all sharing the same access token — stored as `pub/{token}/siteUrls`
(the legacy single `pub/{token}/siteUrl` is still read for backward
compatibility). On every submission the Worker compares the request origin
against **every** registered site. A submission from an **unrecognized origin**
(matching none of them) is treated as token exposure:

- The form data is **never forwarded** to Telegram.
- The owner gets a **security-alert** Telegram message.
- An `exposedChances` counter is incremented (`pub/{token}/meta`).
- After **3** exposure attempts the token is **auto-blocked** (`blocked: true`) and all
  further submissions are rejected with `403`.

A matching origin (exact or a real subdomain of any registered host) is a
legitimate submission and is delivered normally — it does **not** bump the
exposure counter. If **no** sites are registered yet, all origins are allowed.

### 3. Token blocking & regeneration
- A blocked token returns `403 "Access token blocked"` and delivers nothing.
- **Regenerate** in the dashboard creates a new token, writes the new `pub/{token}`
  nodes, sets the old token `blocked: true` (and clears its `telegram`/`uid`/`siteUrl`),
  and resets `exposedChances`/`blocked` on the profile. The old snippet stops working.

### 4. Server-side idempotency & de-duplication
The Worker claims a short-lived (15s) lock keyed by
`token + page + fields` **before** sending, so concurrent or rapidly-retried identical
submissions are delivered to Telegram **only once**. Successful deliveries are also
cached (per-hash) to suppress repeats.

### 5. Caching & rate guards
- Invalid tokens are cached as "not linked" for 60s to avoid hammering Firebase.
- Request body is capped at 50 KB; fields capped at 100; field values at 5000 chars.
- Telegram send has a 5s timeout with `AbortController`.

### 6. Firebase rules (deployer responsibility)
The Worker talks to Firebase over the **unauthenticated REST API**, so the database
rules must permit the Worker's reads/writes. The bookkeeping the Worker writes
(submission count, last submission, exposure, blocked) lives in **`pub/{token}/meta`**,
which must be publicly writable, while private profile data under `users/{uid}` stays
owner-only. The owner's client also writes the registered origins to
**`pub/{token}/siteUrl`** and **`pub/{token}/siteUrls`** (the multi-site list), which
the Worker reads to validate submission origins. The dashboard reads
`pub/{token}/meta` to display those stats. Configure the exact rules in the Firebase
console for your project.

---

## Configuration

### Firebase (frontend)
The site reads `window.__ENV__.firebase` from `public/js/firebase-init.js` (your real
config is set there). If Firebase isn't reachable it falls back to **demo mode**
(localStorage) so the UI still works.

### Cloudflare Worker secrets / vars
Set these in the `trigifyx-worker` environment (wrangler / Cloudflare dashboard).
The exact variable names are defined in `worker/wrangler.toml` and `worker/worker.js`
— only their purpose is described here:

| Purpose | Type | Notes |
|---------|------|-------|
| Telegram bot token | **Secret** | Server-side Telegram delivery. Never exposed to the browser. |
| Firebase database URL | Variable | RTDB base URL for resolving chat ids and storing bookkeeping. |
| CORS origin allowlist | Variable (optional) | Restricts `/api/submit` origins (defaults to open). |

### Telegram bot (optional helper)
Set on the host that runs `bot/server.py` (e.g. `cloud.tranger.xyz`):

```
<BOT_TOKEN_VAR>=...              # required
<FIREBASE_URL_VAR>=...           # when set, the bot persists chat ids to Firebase (tg/{chat_id})
<WEBHOOK_URL_VAR>=...            # optional, e.g. https://cloud.tranger.xyz/bot -> webhook mode
<PORT_VAR>=8000                  # optional webhook listen port
```

The precise variable names live in `bot/server.py` (read via `os.getenv`). In
summary:

- **Polling mode (default):** no public URL needed. The bot long-polls Telegram directly.
- **Webhook mode:** point the webhook variable at your public HTTPS endpoint; Telegram
  POSTs updates there. Telegram only requires the URL be HTTPS — there is no separate
  "trusted domain" allowlist in the bot.

---

## Deploy

### Cloudflare Worker (required backend)
```
cd worker
wrangler deploy          # deploys trigifyx-worker
```
Endpoints: `GET /`, `GET /health`, `GET /trigifyx-capture.js`,
`POST /api/submit`, `POST /test-message`.

### Static site (dashboard)
Serve `public/` from any static host (Netlify, Vercel, or `cloud.tranger.xyz`).
`netlify deploy --prod` (or your host's equivalent). `netlify.toml` publishes `public/`.

### Telegram bot (optional, separate host)
```
cd bot && pip install -r requirements.txt && python server.py
```

---

## How the embeddable script works

1. The dashboard generates a snippet:
   ```html
   <script>
     window.TRIGIFYX = { accessToken: "<token>", endpoint: "https://trigifyx-worker.xxx.workers.dev" };
   </script>
   <script src="https://trigifyx-worker.xxx.workers.dev/trigifyx-capture.js" defer></script>
   ```
2. `trigifyx-capture.js` scans for `<form>`s (including dynamically added ones via
   `MutationObserver`), serializes non-password fields on submit, and `POST`s
   `{ accessToken, fields, page }` to `/api/submit`.
3. The Worker resolves the chat id, validates the origin, and forwards the message to
   Telegram. Submissions are queued in `localStorage` and retried with exponential
   backoff, so a transient failure does not lose data.

## Dashboard stats

The live dashboard shows (read from `pub/{token}/meta`):
- **Submission count** (`submissionCount`)
- **Last submission** time + page (`lastSubmissionAt`, `lastSubmissionPage`)
- **Exposure** `exposedChances / 3` and blocked state
- **Access token** (with Copy + Regenerate)

---

## Project layout

```
public/                Static site + dashboard (Firebase web SDK)
  index.html           Dashboard / setup UI
  js/app.js            Auth, profile, token regen, snippet, stats
  js/firebase-init.js  Firebase config
  js/trigifyx-capture.js  Embeddable capture script (also served by the Worker)
worker/                Cloudflare Worker (secure backend)
  worker.js            fetch handler, resolveDestination, security rules
  wrangler.toml        Worker config
bot/                   Optional Telegram helper bot (Python)
  server.py            /start, /myid, /help + Firebase chat-id persistence
```

> Note: `old*` files in the repo are previous reference copies and are gitignored —
> they must never be committed or deployed.
