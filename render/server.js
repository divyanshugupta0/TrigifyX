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

app.get("/", (req, res) => res.json({ ok: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/telegram/chat", async (req, res) => {
  try {
    const { telegram_chat_id, username } = req.body || {};
    if (!telegram_chat_id) return res.status(400).json({ ok: false, error: "telegram_chat_id required" });
    if (!username) return res.status(400).json({ ok: false, error: "username required" });

    const telegram = String(username).trim().toLowerCase();
    let matched = false;
    let token = null;

    if (db) {
      const snap = await db.ref("pub").orderByChild("telegram").equalTo(telegram).limitToFirst(1).once("value");
      if (snap.exists()) {
        token = Object.keys(snap.val())[0];
        matched = true;
      }
    } else {
      const url = `${FIREBASE_DB_URL}/pub.json?orderBy="telegram"&equalTo="${encodeURIComponent(telegram)}"&limitToFirst=1`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data) {
          token = Object.keys(data)[0];
          matched = true;
        }
      }
    }

    if (!matched || !token) {
      return res.status(404).json({ ok: false, error: "no matching telegram link found" });
    }

    if (db) {
      await db.ref("pub/" + token + "/telegram_chat_id").set(String(telegram_chat_id));
    } else {
      await fetch(`${FIREBASE_DB_URL}/pub/${token}/telegram_chat_id.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(String(telegram_chat_id)),
      });
    }

    console.log("[render] matched telegram -> token:", token, "chat_id:", telegram_chat_id);
    return res.status(204).send();
  } catch (e) {
    console.error("[render] save chat failed:", e);
    return res.status(500).json({ ok: false, error: "save_failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[render] listening on ${PORT}`);
});
