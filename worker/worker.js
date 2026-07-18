/*
 * TrigifyX Cloudflare Worker
 * --------------------------
 * Edge-delivered backend. The TrigifyX frontend (deployed on ANY platform)
 * POSTs form submissions to this Worker. The Worker authenticates with the
 * per-user accessToken, resolves the destination chat id from Firebase
 * Realtime Database via the REST API, and sends to Telegram. The bot token
 * stays 100% in Worker secrets â€” never in the browser.
 *
 * The Worker ALSO serves the capture script at /trigifyx-capture.js, so users
 * only embed a <script src="https://<worker>/trigifyx-capture.js"> â€” they do
 * NOT need to upload any file to their own site.
 *
 * IMPORTANT (Cloudflare variable naming):
 *   Worker variable/secret NAMES may contain ONLY letters, numbers and
 *   underscores â€” no dots. So name them exactly:
 *     TELEGRAM_BOT_TOKEN   (secret)  -> your @BotFather token
 *     FIREBASE_DB_URL      (var)     -> https://trigifyx-default-rtdb.asia-southeast1.firebasedatabase.app
 *     ALLOWED_ORIGINS      (optional)-> comma-separated origins; default "*"
 *   Do NOT name a variable "window.ENV.apiBase" or anything with a dot.
 *
 * Endpoints:
 *   GET  /                        -> status page (shows whether secrets are configured)
 *   GET  /health                  -> { ok: true }
 *   GET  /trigifyx-capture.js     -> the embeddable capture script
 *   POST /api/submit              -> body { accessToken, fields, page }
 */

const CAPTURE_JS = `/* TrigifyX capture script (secure, backend-delivered) */
(function () {
  var cfg = window.TRIGIFYX || {};
  var ENV = window.__ENV__ || {};
  if (!cfg.accessToken) {
    console.warn("[TrigifyX] Missing window.TRIGIFYX.accessToken - capture disabled.");
    return;
  }
  var API_BASE = (cfg.endpoint || ENV.apiBase || "").replace(/\\/$/, "");
  if (!API_BASE) {
    console.warn("[TrigifyX] No endpoint configured (window.TRIGIFYX.endpoint). Capture disabled.");
    return;
  }
  var QUEUE_KEY = "trigifyx_queue_v1";
  var DELIVERED_KEY = "trigifyx_delivered_v1";
  var SENT_SIGS = {};
  var IN_FLIGHT = {};
  function collect(form) {
    var data = {};
    var els = form.querySelectorAll("input, select, textarea");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var name = el.name || el.id || ("field" + i);
      if (el.type === "password") continue;
      if (el.type === "submit" || el.type === "button") continue;
      if (el.type === "checkbox" || el.type === "radio") {
        if (el.checked) data[name] = data[name] ? data[name] + ", " + el.value : el.value;
      } else if (el.value) {
        data[name] = el.value;
      }
    }
    return data;
  }
  function deliver(item) {
    return fetch(API_BASE + "/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: item.token, fields: item.body.fields, page: item.body.page })
    }).then(function (res) { if (!res.ok) throw new Error("HTTP " + res.status); return res; });
  }
  function readQueue() { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (e) { return []; } }
  function writeQueue(items) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); } catch (e) {} }
  function enqueue(item) { var q = readQueue(); q.push(item); writeQueue(q); }
  function dequeue(id) { writeQueue(readQueue().filter(function (x) { return x.id !== id; })); }
  function isDelivered(sig) { try { var d = JSON.parse(localStorage.getItem(DELIVERED_KEY) || "{}"); return !!d[sig]; } catch (e) { return false; } }
  function markDelivered(sig) {
    try {
      var d = JSON.parse(localStorage.getItem(DELIVERED_KEY) || "{}");
      d[sig] = Date.now();
      var keys = Object.keys(d);
      if (keys.length > 200) { keys.sort(function (a, b) { return d[a] - d[b]; }); for (var i = 0; i < keys.length - 200; i++) delete d[keys[i]]; }
      localStorage.setItem(DELIVERED_KEY, JSON.stringify(d));
    } catch (e) {}
  }
  function sendOne(item, attempt) {
    attempt = attempt || 0;
    if (IN_FLIGHT[item.id]) return;
    if (isDelivered(item.sig)) { dequeue(item.id); return; }
    IN_FLIGHT[item.id] = true;
    deliver(item).then(function (res) {
      if (res.ok) { dequeue(item.id); markDelivered(item.sig); delete SENT_SIGS[item.sig]; }
      else throw new Error("HTTP " + res.status);
    }).catch(function (e) {
      if (attempt < 5) { var delay = Math.min(1000 * Math.pow(2, attempt), 30000); setTimeout(function () { sendOne(item, attempt + 1); }, delay); }
      else { console.warn("[TrigifyX] Send failed after retries:", e); delete SENT_SIGS[item.sig]; }
    }).then(function () { delete IN_FLIGHT[item.id]; });
  }
  function flushQueue() { readQueue().forEach(function (item) { sendOne(item, 0); }); }
  function submit(form) {
    var data = collect(form);
    var sig = JSON.stringify(data) + "|" + location.href;
    if (isDelivered(sig) || SENT_SIGS[sig]) return;
    SENT_SIGS[sig] = true;
    setTimeout(function () { delete SENT_SIGS[sig]; }, 4000);
    var item = { id: Date.now() + "_" + Math.random().toString(36).slice(2), token: cfg.accessToken, sig: sig, body: { fields: data, page: location.href, ts: Date.now() } };
    // Mark delivered synchronously (persisted) so a native submit / reload
    // cannot resend via flushQueue() (prevents triple delivery).
    markDelivered(sig);

    enqueue(item);
    sendOne(item, 0);
  }
  function attach(form) { if (form.__trigifyx) return; form.__trigifyx = true; form.addEventListener("submit", function () { try { submit(form); } catch (err) { console.warn("[TrigifyX]", err); } }); }
  function scan() { var forms = document.querySelectorAll("form"); for (var i = 0; i < forms.length; i++) attach(forms[i]); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { scan(); flushQueue(); });
  else { scan(); flushQueue(); }
  var obs = window.MutationObserver && new MutationObserver(function (m) {
    for (var i = 0; i < m.length; i++) { var nodes = m[i].addedNodes || []; for (var j = 0; j < nodes.length; j++) { if (nodes[j].nodeType === 1) { if (nodes[j].tagName === "FORM") attach(nodes[j]); else if (nodes[j].querySelectorAll) { var f = nodes[j].querySelectorAll("form"); for (var k = 0; k < f.length; k++) attach(f[k]); } } } }
  });
  if (obs) obs.observe(document.documentElement, { childList: true, subtree: true });
})();`;

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

    if (url.pathname === "/trigifyx-capture.js") {
      return new Response(CAPTURE_JS, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "public, max-age=86400",
        },
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
