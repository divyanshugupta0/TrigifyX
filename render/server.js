import express from "express";
import admin from "firebase-admin";

const app = express();
app.use(express.json({ limit: "50kb" }));

const FIREBASE_SA_KEY = process.env.FIREBASE_SA_KEY || "";
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || "").replace(/\/$/, "");

let db = null;

if (FIREBASE_SA_KEY) {
  try {
    const sa = typeof FIREBASE_SA_KEY === "string" ? JSON.parse(FIREBASE_SA_KEY) : FIREBASE_SA_KEY;
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      databaseURL: FIREBASE_DB_URL,
    });
    db = admin.database();
    console.log("[render] Firebase Admin initialized");
  } catch (e) {
    console.warn("[render] Firebase Admin init failed:", e);
  }
}

function appendSlash(path) {
  return (FIREBASE_DB_URL + "/" + path + ".json").replace(/([^:]\/)\/+/g, "$1");
}

async function saveChat(chat_id, username, linkedAt) {
  const payload = { telegram_chat_id: String(chat_id), username: username || null, linkedAt: linkedAt || Date.now() };
  if (db) {
    await db.ref("tg/" + chat_id).set(payload);
  } else if (FIREBASE_DB_URL) {
    const res = await fetch(appendSlash("tg/" + chat_id), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("fb_save_" + res.status);
  }
}

async function readChats() {
  if (db) {
    const snap = await db.ref("tg").once("value");
    const data = snap.val() || {};
    return Object.entries(data).map(([id, v]) => ({ telegram_chat_id: id, username: v?.username || null, linkedAt: v?.linkedAt || null }));
  }
  if (!FIREBASE_DB_URL) return [];
  const res = await fetch(appendSlash("tg"));
  if (!res.ok) return [];
  const data = await res.json();
  if (!data || typeof data !== "object") return [];
  return Object.entries(data).map(([id, v]) => ({ telegram_chat_id: id, username: v?.username || null, linkedAt: v?.linkedAt || null }));
}

app.get("/", (req, res) => res.json({ ok: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/telegram/chat", async (req, res) => {
  try {
    const { telegram_chat_id, username, linkedAt } = req.body || {};
    if (!telegram_chat_id) return res.status(400).json({ ok: false, error: "telegram_chat_id required" });
    await saveChat(telegram_chat_id, username, linkedAt);
    console.log("[render] saved chat:", telegram_chat_id, username);
    return res.status(201).json({ ok: true });
  } catch (e) {
    console.error("[render] save chat failed:", e);
    return res.status(500).json({ ok: false, error: "save_failed" });
  }
});

app.get("/api/telegram/chats", async (req, res) => {
  try {
    const chats = await readChats();
    return res.json({ ok: true, chats });
  } catch (e) {
    console.error("[render] read chats failed:", e);
    return res.status(500).json({ ok: false, error: "read_failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[render] listening on ${PORT}`);
});
