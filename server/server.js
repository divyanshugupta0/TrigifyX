/*
 * TrigifyX backend server
 * -----------------------
 * Replaces the pure-frontend "post straight to Telegram" approach with a
 * trusted server. Benefits:
 *   - The Telegram bot token stays 100% server-side (never in the browser).
 *   - Capture requests are authenticated with the per-user `accessToken`
 *     (the only secret embedded in the user's snippet).
 *   - The destination chat id is resolved from Firebase (Admin SDK), so it
 *     is never exposed in the page source.
 *
 * Endpoints:
 *   GET  /health                         -> { ok: true }
 *   POST /api/submit                     -> accepts a form submission
 *        body: { accessToken, fields, page }
 *        resolves pub/<accessToken>/telegram and forwards to Telegram.
 *
 * Env vars (set in your host / .env):
 *   TELEGRAM_BOT_TOKEN   (required) BotFather token for @TrigifyXbot
 *   PORT                  (optional) listen port, default 3000
 *   ALLOWED_ORIGINS      (optional) comma-separated CORS origins; default "*"
 *   FIREBASE_SERVICE_ACCOUNT  (required) path to the service-account JSON,
 *                             OR individual FIREBASE_* vars below.
 *   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
 *   FIREBASE_DATABASE_URL (optional, only if using a non-default RTDB)
 */

const express = require("express");
const path = require("path");
const fs = require("fs");

// ---------- Load env (.env if present) ----------
try {
  require("dotenv").config();
} catch (_) {
  // dotenv is optional; env vars may be provided by the host directly.
}
// Minimal .env parser fallback if dotenv isn't installed.
if (!process.env.TELEGRAM_BOT_TOKEN) {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, "utf8")
      .split("\n")
      .forEach((line) => {
        const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
      });
  }
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = parseInt(process.env.PORT || "3000", 10);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim());

if (!TELEGRAM_BOT_TOKEN) {
  console.error("FATAL: TELEGRAM_BOT_TOKEN is required.");
  process.exit(1);
}

// ---------- Firebase Admin ----------
let admin;
try {
  admin = require("firebase-admin");
} catch (e) {
  console.error("FATAL: firebase-admin not installed. Run `npm install`.");
  process.exit(1);
}

function initFirebase() {
  if (admin.apps.length) return admin.app();

  const saPath = process.env.FIREBASE_SERVICE_ACCOUNT;
  let credential;
  if (saPath && fs.existsSync(saPath)) {
    credential = admin.credential.cert(require(path.resolve(saPath)));
  } else if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    credential = admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    });
  } else {
    // Last resort: default credentials (e.g. Google Cloud Run / App Engine).
    credential = admin.credential.applicationDefault();
  }

  const params = { credential };
  if (process.env.FIREBASE_DATABASE_URL) {
    params.databaseURL = process.env.FIREBASE_DATABASE_URL;
  }
  return admin.initializeApp(params);
}

const firebaseApp = initFirebase();
const db = admin.database(firebaseApp);

// ---------- Telegram delivery ----------
async function sendTelegram(chatId, text) {
  const url =
    "https://api.telegram.org/bot" +
    TELEGRAM_BOT_TOKEN +
    "/sendMessage";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error("Telegram HTTP " + res.status + ": " + body);
  }
  return res.json();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildMessage(fields, page) {
  const lines = ["<b>New form submission</b>"];
  const keys = Object.keys(fields || {});
  if (keys.length === 0) {
    lines.push("(no fields captured)");
  } else {
    keys.forEach((k) => {
      lines.push(
        "<b>" + escapeHtml(k) + ":</b> " + escapeHtml(String(fields[k]))
      );
    });
  }
  lines.push("");
  lines.push("<i>Page:</i> " + escapeHtml(page || "unknown"));
  lines.push("via TrigifyX");
  return lines.join("\n");
}

// Resolve the destination chat id for a token via the Admin SDK.
async function resolveChatId(accessToken) {
  if (!accessToken || typeof accessToken !== "string") return null;
  const snap = await db
    .ref("pub/" + accessToken + "/telegram")
    .once("value");
  const v = snap.val();
  return v ? String(v) : null;
}

// ---------- Express app ----------
const app = express();
app.use(express.json({ limit: "256kb" }));

// CORS (capture script runs on the user's own site).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes("*") || (origin && ALLOWED_ORIGINS.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/submit", async (req, res) => {
  try {
    const { accessToken, fields, page } = req.body || {};
    if (!accessToken) {
      return res.status(400).json({ ok: false, error: "missing accessToken" });
    }
    if (!fields || typeof fields !== "object") {
      return res.status(400).json({ ok: false, error: "missing fields" });
    }

    const chatId = await resolveChatId(accessToken);
    if (!chatId) {
      return res
        .status(404)
        .json({ ok: false, error: "no destination linked for this token" });
    }

    const text = buildMessage(fields, page);
    await sendTelegram(chatId, text);
    return res.json({ ok: true });
  } catch (e) {
    console.error("submit error:", e.message);
    return res.status(500).json({ ok: false, error: "delivery failed" });
  }
});

app.listen(PORT, () => {
  console.log("TrigifyX server listening on :" + PORT);
});

module.exports = app;
