/*
 * TrigifyX Cloudflare Worker
 * --------------------------
 * Edge-delivered backend. The TrigifyX frontend (deployed on ANY platform)
 * POSTs form submissions to this Worker. The Worker authenticates with the
 * per-user accessToken, resolves the destination chat id from Firebase
 * Realtime Database via the REST API, and sends to Telegram. The bot token
 * stays 100% in Worker secrets — never in the browser.
 *
 * IMPORTANT (Cloudflare variable naming):
 *   Worker variable/secret NAMES may contain ONLY letters, numbers and
 *   underscores — no dots. So name them exactly:
 *     TELEGRAM_BOT_TOKEN   (secret)  -> your @BotFather token
 *     FIREBASE_DB_URL      (var)     -> https://trigifyx-default-rtdb.asia-southeast1.firebasedatabase.app
 *     ALLOWED_ORIGINS      (optional)-> comma-separated origins; default "*"
 *   Do NOT name a variable "window.ENV.apiBase" or anything with a dot.
 *
 * Endpoints:
 *   GET  /            -> status page (shows whether secrets are configured)
 *   GET  /health      -> { ok: true }
 *   POST /api/submit  -> body { accessToken, fields, page }
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }), env);
    }

    if (url.pathname === "/health" || url.pathname === "/") {
      const configured = !!(
        getEnv(env, "TELEGRAM_BOT_TOKEN", "BOT_TOKEN") &&
        getEnv(env, "FIREBASE_DB_URL", "DB_URL")
      );
      return json({
        ok: true,
        service: "trigifyx-worker",
        configured,
        note: "POST form submissions to /api/submit",
      });
    }

    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/api/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    return json(
      { ok: false, error: "not found. POST to /api/submit" },
      404
    );
  },
};

// Read an env value trying one or more allowed names.
function getEnv(env, ...names) {
  for (const n of names) {
    if (env[n]) return env[n];
  }
  return "";
}

async function handleSubmit(request, env) {
  const botToken = getEnv(env, "TELEGRAM_BOT_TOKEN", "BOT_TOKEN");
  const dbUrlBase = getEnv(env, "FIREBASE_DB_URL", "DB_URL");

  if (!botToken) {
    return json({ ok: false, error: "server misconfigured (bot token)" }, 500);
  }
  if (!dbUrlBase) {
    return json({ ok: false, error: "server misconfigured (db url)" }, 500);
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

  const dbUrl = dbUrlBase.replace(/\/$/, "");
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

  const text = buildMessage(fields, page);
  try {
    const res = await fetch(
      "https://api.telegram.org/bot" + botToken + "/sendMessage",
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
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  const allowed = (getEnv(env, "ALLOWED_ORIGINS", "ALLOWED_ORIGIN") || "*")
    .split(",")
    .map((s) => s.trim());
  if (allowed[0] === "*") {
    res.headers.set("Access-Control-Allow-Origin", "*");
  }
  return res;
}
