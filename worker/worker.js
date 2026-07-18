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

const CAPTURE_JS = `/* TrigifyX v2 — Form-to-Telegram capture script */
(function () {
  'use strict';

  var cfg = window.TRIGIFYX || {};
  var ENV = window.__ENV__ || {};

  // --- Config ---
  var TOKEN = cfg.accessToken || '';
  var API_BASE = (cfg.endpoint || ENV.apiBase || '').replace(/\\/$/, '');

  if (!TOKEN) {
    console.warn('[TrigifyX] Missing accessToken. No forms will be captured.');
    return;
  }
  if (!API_BASE) {
    console.warn('[TrigifyX] No endpoint. Set window.TRIGIFYX.endpoint or window.__ENV__.apiBase.');
    return;
  }

  console.log('[TrigifyX] Initialized — endpoint:', API_BASE);

  // --- Storage keys ---
  var QUEUE_KEY = 'trigifyx_queue';
  var SENT_KEY = 'trigifyx_sent';

  // --- In-memory dedup (cleared every 5s) ---
  var recentSigs = {};

  // --- Helpers ---
  function readStore(key) {
    try { return JSON.parse(localStorage.getItem(key) || '[]'); }
    catch (e) { return []; }
  }
  function writeStore(key, items) {
    try { localStorage.setItem(key, JSON.stringify(items)); } catch (e) {}
  }
  function isSent(sig) {
    try {
      var sent = JSON.parse(localStorage.getItem(SENT_KEY) || '{}');
      return !!sent[sig];
    } catch (e) { return false; }
  }
  function markSent(sig) {
    try {
      var sent = JSON.parse(localStorage.getItem(SENT_KEY) || '{}');
      sent[sig] = Date.now();
      // Keep only last 200 entries
      var keys = Object.keys(sent);
      if (keys.length > 200) {
        keys.sort(function (a, b) { return sent[a] - sent[b]; });
        for (var i = 0; i < keys.length - 200; i++) delete sent[keys[i]];
      }
      localStorage.setItem(SENT_KEY, JSON.stringify(sent));
    } catch (e) {}
  }

  // --- Collect form data ---
  function collect(form) {
    var data = {};
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.name && !el.id) continue;
      if (el.type === 'submit' || el.type === 'button') continue;
      if (el.type === 'password') continue;
      var name = el.name || el.id;
      if (el.type === 'checkbox') {
        if (el.checked) data[name] = data[name] ? data[name] + ', ' + el.value : el.value;
      } else if (el.type === 'radio') {
        if (el.checked) data[name] = el.value;
      } else if (el.value) {
        data[name] = el.value;
      }
    }
    return data;
  }

  // --- Send to worker ---
  function sendToWorker(fields, page, token) {
    return fetch(API_BASE + '/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: token,
        fields: fields,
        page: page
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  // --- Queue management ---
  function addToQueue(item) {
    var q = readStore(QUEUE_KEY);
    q.push(item);
    writeStore(QUEUE_KEY, q);
  }
  function removeFromQueue(id) {
    writeStore(QUEUE_KEY, readStore(QUEUE_KEY).filter(function (x) { return x.id !== id; }));
  }

  // --- Retry with exponential backoff ---
  function retry(item, attempt) {
    attempt = attempt || 0;
    if (attempt > 5) {
      console.warn('[TrigifyX] Failed after ' + attempt + ' retries:', item);
      return;
    }
    var delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    setTimeout(function () {
      processItem(item, attempt);
    }, delay);
  }

  function processItem(item, attempt) {
    attempt = attempt || 0;
    // Already sent? Remove from queue.
    if (isSent(item.sig)) {
      removeFromQueue(item.id);
      return;
    }
    sendToWorker(item.fields, item.page, item.token).then(function (res) {
      if (res && res.ok) {
        removeFromQueue(item.id);
        markSent(item.sig);
        delete recentSigs[item.sig];
        console.log('[TrigifyX] Sent successfully');
      } else {
        throw new Error('Unexpected response');
      }
    }).catch(function (err) {
      console.warn('[TrigifyX] Send error:', err.message);
      retry(item, attempt + 1);
    });
  }

  // --- Flush queued items on load ---
  function flushQueue() {
    var q = readStore(QUEUE_KEY);
    console.log('[TrigifyX] Flushing ' + q.length + ' queued items');
    q.forEach(function (item) { processItem(item, 0); });
  }

  // --- Core submit handler ---
  function handleSubmit(form, event) {
    // ALWAYS prevent native submission
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    var fields = collect(form);
    var keys = Object.keys(fields);
    if (keys.length === 0) {
      console.warn('[TrigifyX] No fields collected from form');
      return;
    }

    var sig = JSON.stringify(fields) + '|' + location.href;

    // Dedup: skip if already sent recently
    if (isSent(sig) || recentSigs[sig]) {
      console.log('[TrigifyX] Duplicate submission skipped');
      return;
    }

    // Mark as in-flight (in-memory, 5s window)
    recentSigs[sig] = true;
    setTimeout(function () { delete recentSigs[sig]; }, 5000);

    // Persist sent marker immediately (survives page reload)
    markSent(sig);

    var item = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 10),
      token: TOKEN,
      sig: sig,
      fields: fields,
      page: location.href,
      ts: Date.now()
    };

    console.log('[TrigifyX] Submitting:', keys.join(', '));

    // Add to queue (in case send fails)
    addToQueue(item);

    // Send immediately
    processItem(item, 0);
  }

  // --- Attach to a form ---
  function attach(form) {
    if (form._trigifyxAttached) return;
    form._trigifyxAttached = true;

    // Use capture phase to ensure we run before any other handler
    form.addEventListener('submit', function (e) {
      handleSubmit(form, e);
    }, true); // capture = true
  }

  // --- Scan for forms ---
  function scan() {
    var forms = document.querySelectorAll('form');
    for (var i = 0; i < forms.length; i++) {
      attach(forms[i]);
    }
  }

  // --- Observe dynamically added forms ---
  function startObserver() {
    if (!window.MutationObserver) return;
    var obs = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes || [];
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType !== 1) continue; // not an element
          if (node.tagName === 'FORM') {
            attach(node);
          } else {
            var subForms = node.querySelectorAll('form');
            for (var k = 0; k < subForms.length; k++) {
              attach(subForms[k]);
            }
          }
        }
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  // --- Init ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      scan();
      flushQueue();
      startObserver();
    });
  } else {
    scan();
    flushQueue();
    startObserver();
  }
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
      }, 200, env);
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
      404,
      env
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
    return json({ ok: false, error: "server misconfigured (bot token)" }, 500, env);
  }
  if (!dbUrlBase) {
    return json({ ok: false, error: "server misconfigured (db url)" }, 500, env);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ ok: false, error: "invalid json" }, 400, env);
  }

  const { accessToken, fields, page } = payload || {};
  if (!accessToken || typeof accessToken !== "string") {
    return json({ ok: false, error: "missing accessToken" }, 400, env);
  }
  if (!fields || typeof fields !== "object") {
    return json({ ok: false, error: "missing fields" }, 400, env);
  }

  const dbUrl = dbUrlBase.replace(/\/$/, "");
  let chatId = null;
  let fbStatus = null;
  let fbBody = null;
  try {
    const r = await fetch(
      dbUrl + "/pub/" + encodeURIComponent(accessToken) + "/telegram.json"
    );
    fbStatus = r.status;
    fbBody = (await r.text()) || "";
    if (r.ok) {
      let v = null;
      try { v = JSON.parse(fbBody); } catch (_) { v = null; }
      if (v) chatId = String(v).trim();
    }
  } catch (e) {
    fbStatus = "fetch-error";
    fbBody = e.message;
  }
  if (!chatId) {
    return json(
      {
        ok: false,
        error: "no destination linked for this token",
        debug: {
          accessToken: accessToken.slice(0, 8) + "...",
          dbUrl: dbUrl,
          firebaseStatus: fbStatus,
          firebaseBody: fbBody.slice(0, 120),
        },
      },
      404,
      env
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
      return json({ ok: false, error: "telegram failed: " + res.status + " " + (body || "").slice(0, 200) }, 502, env);
    }
    return json({ ok: true }, env);
  } catch (e) {
    return json({ ok: false, error: "delivery failed: " + e.message }, 500, env);
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

function json(obj, status = 200, env = {}) {
  return corsResponse(
    new Response(JSON.stringify(obj), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    env
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
