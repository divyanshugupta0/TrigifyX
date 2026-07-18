/* TrigifyX capture script (secure, backend-delivered)
 *
 * Embeds on the user's site. On form submit it:
 *   1. Reads window.TRIGIFYX.accessToken (per-user, un-guessable).
 *   2. POSTs the submission to the TrigifyX backend (apiBase + /api/submit).
 *   3. The backend resolves the destination chat id from Firebase and sends
 *      the message to Telegram. The bot token NEVER reaches the browser.
 *
 * No apiKey/chatId/botToken hardcoded in the snippet.
 */
(function () {
  var cfg = window.TRIGIFYX || {};
  var ENV = window.__ENV__ || {};
  if (!cfg.accessToken) {
    console.warn("[TrigifyX] Missing window.TRIGIFYX.accessToken — capture disabled.");
    return;
  }

  // Where the backend lives. Set window.TRIGIFYX.endpoint or ENV.apiBase.
  var API_BASE = (cfg.endpoint || ENV.apiBase || "").replace(/\/$/, "");
  if (!API_BASE) {
    console.warn("[TrigifyX] No endpoint configured (window.TRIGIFYX.endpoint). Capture disabled.");
    return;
  }

  var QUEUE_KEY = "trigifyx_queue_v1";
  var DELIVERED_KEY = "trigifyx_delivered_v1";
  var SENT_SIGS = {};   // in-memory de-dup for the current page load
  var IN_FLIGHT = {};   // queue item ids currently being sent (prevents double flush)

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

  // Send a submission to the backend. The backend resolves the chat id and
  // delivers to Telegram — the bot token stays server-side.
  function deliver(item) {
    return fetch(API_BASE + "/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accessToken: item.token,
        fields: item.body.fields,
        page: item.body.page
      })
    }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res;
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
    deliver(item).then(function (res) {
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
      body: { fields: data, page: location.href, ts: Date.now() }
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
