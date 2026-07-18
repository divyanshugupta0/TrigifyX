/* TrigifyX capture script (pure frontend)
 * Users embed this on their site. It listens for form submissions, serializes
 * the fields, and delivers them straight to Telegram via @TrigifyXbot — no
 * backend server required. The bot token comes from window.TRIGIFYX.token
 * (injected from deploy env vars), so it is never needed at runtime on a server.
 *
 * Resilient: submissions are queued in localStorage and retried with backoff,
 * so a transient network failure does not lose data.
 */
(function () {
  var cfg = window.TRIGIFYX || {};
  if (!cfg.apiKey) {
    console.warn("[TrigifyX] Missing window.TRIGIFYX.apiKey — form capture disabled.");
    return;
  }

  var QUEUE_KEY = "trigifyx_queue_v1";

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
    var lines = ["🔔 New form submission", ""];
    var keys = Object.keys(data);
    for (var i = 0; i < keys.length; i++) {
      lines.push(keys[i] + ": " + data[keys[i]]);
    }
    lines.push("");
    lines.push("🌐 " + location.href);
    lines.push("via TrigifyX");
    return lines.join("\n");
  }

  function buildBody(data) {
    return {
      apiKey: cfg.apiKey,
      bot: cfg.bot || "TrigifyXbot",
      telegram: cfg.telegram || "",
      text: buildText(data),
      fields: data,
      page: location.href,
      ts: Date.now()
    };
  }

  // ---------- Offline queue (survives network blips) ----------
  function readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function writeQueue(items) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); } catch (e) {}
  }
  function enqueue(item) {
    var q = readQueue(); q.push(item); writeQueue(q);
  }
  function dequeue(id) {
    writeQueue(readQueue().filter(function (x) { return x.id !== id; }));
  }

  function postDirect(body) {
    // Plain text (no parse_mode) for maximum reliability from the browser.
    return fetch("https://api.telegram.org/bot" + cfg.token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.telegram, text: body.text })
    });
  }

  function sendOne(item, attempt) {
    attempt = attempt || 0;
    if (!cfg.token || !cfg.telegram) {
      console.log("[TrigifyX] No token/telegram set. Queued:", item.body);
      return;
    }
    postDirect(item.body).then(function (res) {
      if (res.ok) dequeue(item.id);
      else throw new Error("HTTP " + res.status);
    }).catch(function (e) {
      if (attempt < 5) {
        var delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        setTimeout(function () { sendOne(item, attempt + 1); }, delay);
      } else {
        console.warn("[TrigifyX] Send failed after retries, kept in queue:", e);
      }
    });
  }

  function flushQueue() {
    readQueue().forEach(function (item) { sendOne(item, 0); });
  }

  function send(data) {
    var item = { id: Date.now() + "_" + Math.random().toString(36).slice(2), body: buildBody(data) };
    enqueue(item);
    sendOne(item, 0);
    flushQueue();
  }

  function attach(form) {
    if (form.__trigifyx) return;
    form.__trigifyx = true;
    form.addEventListener("submit", function () {
      try { send(collect(form)); } catch (err) { console.warn("[TrigifyX]", err); }
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
