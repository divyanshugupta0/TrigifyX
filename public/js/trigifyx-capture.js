/* TrigifyX capture script (pure frontend, secure)
 *
 * Embeds on the user's site. On form submit it:
 *   1. Reads window.TRIGIFYX.accessToken (per-user, un-guessable).
 *   2. Fetches the destination chat id from Firebase (pub/<accessToken>),
 *      so the chat id is NEVER in the page source.
 *   3. Sends the submission straight to Telegram via the bot token
 *      (injected from deploy env into window.__ENV__.botToken).
 *
 * No apiKey/chatId hardcoded in the snippet. No backend server.
 */
(function () {
  var cfg = window.TRIGIFYX || {};
  var ENV = window.__ENV__ || {};
  if (!cfg.accessToken) {
    console.warn("[TrigifyX] Missing window.TRIGIFYX.accessToken — capture disabled.");
    return;
  }

  var QUEUE_KEY = "trigifyx_queue_v1";
  var DELIVERED_KEY = "trigifyx_delivered_v1";
  var RTDB = (ENV.databaseURL || "").replace(/\/$/, "");
  var BOT_TOKEN = cfg.token || ENV.botToken || "";
  var SENT_SIGS = {};   // in-memory de-dup for the current page load
  var IN_FLIGHT = {};   // queue item ids currently being sent (prevents double flush)

  // Connection proof: write a small ping to the public verify node so the
  // TrigifyX dashboard can confirm this exact script is loaded on this origin.
  // Uses a dedicated `verify` sub-path (never telegram) so it can't be abused
  // to hijack a victim's destination. Rate-limited to once per 10 minutes.
  function safeKey(s) { return s.replace(/[.$#[\]/]/g, "_"); }
  function pingVerify() {
    if (!RTDB) return;
    try {
      var k = "trigifyx_verify_ping";
      var last = parseInt(localStorage.getItem(k) || "0", 10);
      if (Date.now() - last < 10 * 60 * 1000) return;
      localStorage.setItem(k, String(Date.now()));
      var origin = location.origin;
      fetch(RTDB + "/pub/" + encodeURIComponent(cfg.accessToken) + "/verify/" + safeKey(origin) + ".json", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin: origin, ts: Date.now() })
      }).catch(function () {});
    } catch (e) {}
  }

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

  function buildText(data) {
    var lines = ["New form submission", ""];
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      lines.push(keys[i] + ": " + data[keys[i]]);
    }
    lines.push("");
    lines.push("Page: " + location.href);
    lines.push("via TrigifyX");
    return lines.join("\n");
  }

  function fetchTelegram(token) {
    if (!RTDB) return Promise.reject(new Error("no databaseURL"));
    return fetch(RTDB + "/pub/" + encodeURIComponent(token) + "/telegram.json")
      .then(function (r) { return r.json(); })
      .then(function (v) { if (v == null) throw new Error("no destination"); return String(v); });
  }

  function postToTelegram(telegram, text) {
    if (!BOT_TOKEN) { console.warn("[TrigifyX] No bot token configured."); return Promise.reject(new Error("no token")); }
    return fetch("https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegram, text: text })
    });
  }

  // ---------- Offline queue ----------
  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (e) { return []; }
  }
  function writeQueue(items) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); } catch (e) {}
  }
  function enqueue(item) { var q = readQueue(); q.push(item); writeQueue(q); }
  function dequeue(id) { writeQueue(readQueue().filter(function (x) { return x.id !== id; })); }

  // Persisted set of already-delivered submission signatures so the same
  // submission is never delivered more than once — even across reloads or
  // when it is still sitting in the offline queue.
  function isDelivered(sig) {
    try {
      var d = JSON.parse(localStorage.getItem(DELIVERED_KEY) || "{}");
      return !!d[sig];
    } catch (e) { return false; }
  }
  function markDelivered(sig) {
    try {
      var d = JSON.parse(localStorage.getItem(DELIVERED_KEY) || "{}");
      d[sig] = Date.now();
      // keep only the last 200 delivered signatures
      var keys = Object.keys(d);
      if (keys.length > 200) {
        keys.sort(function (a, b) { return d[a] - d[b]; });
        for (var i = 0; i < keys.length - 200; i++) delete d[keys[i]];
      }
      localStorage.setItem(DELIVERED_KEY, JSON.stringify(d));
    } catch (e) {}
  }

  // Send one queued item exactly once. Guards against:
  //  - the same item being flushed twice (IN_FLIGHT)
  //  - a signature that was already delivered (persisted DELIVERED set)
  //  - duplicate submit events in the same page load (SENT_SIGS)
  function sendOne(item, attempt) {
    attempt = attempt || 0;
    if (IN_FLIGHT[item.id]) return;       // already sending this exact item
    if (isDelivered(item.sig)) {          // already delivered before (incl. prior loads)
      dequeue(item.id);
      return;
    }
    IN_FLIGHT[item.id] = true;
    fetchTelegram(item.token).then(function (telegram) {
      return postToTelegram(telegram, item.body.text);
    }).then(function (res) {
      if (res.ok) {
        dequeue(item.id);
        markDelivered(item.sig);
        delete SENT_SIGS[item.sig];
      } else {
        throw new Error("HTTP " + res.status);
      }
    }).catch(function (e) {
      if (attempt < 5) {
        var delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        setTimeout(function () { sendOne(item, attempt + 1); }, delay);
      } else {
        console.warn("[TrigifyX] Send failed after retries, kept in queue:", e);
        delete SENT_SIGS[item.sig];
      }
    }).then(function () {
      delete IN_FLIGHT[item.id];
    });
  }

  function flushQueue() {
    readQueue().forEach(function (item) { sendOne(item, 0); });
  }

  // Submit handler: enqueue once, send once (no double flush).
  function submit(form) {
    var data = collect(form);
    var sig = JSON.stringify(data) + "|" + location.href;
    // De-dup: skip if already delivered (persisted) or seen this page load.
    if (isDelivered(sig) || SENT_SIGS[sig]) return;
    SENT_SIGS[sig] = true;
    setTimeout(function () { delete SENT_SIGS[sig]; }, 4000);

    var item = {
      id: Date.now() + "_" + Math.random().toString(36).slice(2),
      token: cfg.accessToken,
      sig: sig,
      body: { text: buildText(data), fields: data, page: location.href, ts: Date.now() }
    };
    enqueue(item);
    sendOne(item, 0);
  }

  function attach(form) {
    if (form.__trigifyx) return;
    form.__trigifyx = true;
    form.addEventListener("submit", function () {
      try { submit(form); } catch (err) { console.warn("[TrigifyX]", err); }
    });
  }

  function scan() {
    var forms = document.querySelectorAll("form");
    for (var i = 0; i < forms.length; i++) attach(forms[i]);
  }

  pingVerify();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { scan(); flushQueue(); });
  } else {
    scan(); flushQueue();
  }
  // Re-scan dynamically injected forms (attach is idempotent via __trigifyx).
  var obs = window.MutationObserver && new MutationObserver(function (m) {
    for (var i = 0; i < m.length; i++) {
      var nodes = m[i].addedNodes || [];
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].nodeType === 1) {
          if (nodes[j].tagName === "FORM") attach(nodes[j]);
          else if (nodes[j].querySelectorAll) {
            var f = nodes[j].querySelectorAll("form");
            for (var k = 0; k < f.length; k++) attach(f[k]);
          }
        }
      }
    }
  });
  if (obs) obs.observe(document.documentElement, { childList: true, subtree: true });
})();
