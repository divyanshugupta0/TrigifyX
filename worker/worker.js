/*
 * TrigifyX Cloudflare Worker
 * --------------------------
 * Edge-delivered backend that replaces (or complements) the Node server.
 * The TrigifyX frontend — deployed on ANY platform (Netlify, Vercel, GitHub
 * Pages, a plain VPS, etc.) — simply POSTs form submissions to this Worker.
 *
 * Flow on POST /api/submit  { accessToken, fields, page }:
 *   1. Validate the per-user accessToken.
 *   2. Resolve the destination chat id from Firebase Realtime Database via the
 *      REST API:  GET <DB>/pub/<token>/telegram.json  (public read rule).
 *   3. Send the message to Telegram using the bot token (kept in Worker secrets,
 *      never exposed to the browser).
 *
 * Why a Worker: runs globally at the edge, scales to zero, no server to manage,
 * and the bot token stays 100% server-side.
 *
 * Env / secrets (set via wrangler.toml or `wrangler secret put`):
 *   TELEGRAM_BOT_TOKEN   BotFather token for @TrigifyXbot
 *   FIREBASE_DB_URL      Realtime Database URL, e.g.
 *                        https://trigifyx-default-rtdb.asia-southeast1.firebasedatabase.app
 *   ALLOWED_ORIGINS      (optional) comma-separated CORS origins; "*" = any
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }), env);
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === "/api/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

async function handleSubmit(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return json({ ok: false, error: "server misconfigured" }, 500);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid json" }, 400);
  }

  const { accessToken, fields, page } = payload || {};
  if (!accessToken || typeof accessToken !== "string") {
    return json({ ok: false, error: "missing accessToken" }, 400);
  }
  if (!fields || typeof fields !== "object") {
    return json({ ok: false, error: "missing fields" }, 400);
  }

  // Resolve destination chat id from Firebase (RTDB REST, public read).
  const dbUrl = (env.FIREBASE_DB_URL || "").replace(/\/$/, "");
  if (!dbUrl) {
    return json({ ok: false, error: "server misconfigured (db)" }, 500);
  }
  let chatId = null;
  try {
    const r = await fetch(
      dbUrl + "/pub/" + encodeURIComponent(accessToken) + "/telegram.json"
    );
    if (r.ok) {
      const v = await r.json();
      if (v) chatId = String(v);
    }
  } catch (e) {
    chatId = null;
  }
  if (!chatId) {
    return json(
      { ok: false, error: "no destination linked for this token" },
      404
    );
  }

  // Build + send the Telegram message.
  const text = buildMessage(fields, page);
  try {
    const res = await fetch(
      "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      return json({ ok: false, error: "telegram failed: " + res.status }, 502);
    }
    return corsResponse(json({ ok: true }), env);
  } catch (e) {
    return json({ ok: false, error: "delivery failed" }, 500);
  }
}

function buildMessage(fields, page) {
  const lines = ["<b>New form submission</b>"];
  const keys = Object.keys(fields || {});
  if (keys.length === 0) lines.push("(no fields captured)");
  else
    keys.forEach((k) => {
      lines.push("<b>" + esc(k) + ":</b> " + esc(String(fields[k])));
    });
  lines.push("");
  lines.push("<i>Page:</i> " + esc(page || "unknown"));
  lines.push("via TrigifyX");
  return lines.join("\n");
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function json(obj, status = 200) {
  return corsResponse(
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    {}
  );
}

function corsResponse(res, env) {
  const origin = "";
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  // Allow any origin by default; restrict via ALLOWED_ORIGINS if desired.
  const allowed = (env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((s) => s.trim());
  if (allowed[0] === "*") {
    res.headers.set("Access-Control-Allow-Origin", "*");
  }
  return res;
}
