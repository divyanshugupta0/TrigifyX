import express from "express";

const app = express();
app.use(express.json({ limit: "50kb" }));

app.get("/", (req, res) => res.json({ ok: true }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/telegram/chat", (req, res) => {
  try {
    const { telegram_chat_id } = req.body || {};
    if (!telegram_chat_id) return res.status(400).json({ ok: false, error: "telegram_chat_id required" });
    console.log("[render] received chat:", telegram_chat_id);
    return res.status(204).send();
  } catch (e) {
    console.error("[render] error:", e);
    return res.status(500).json({ ok: false, error: "save_failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[render] listening on ${PORT}`);
});
