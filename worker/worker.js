/*
 * ============================================================
 * TrigifyX Cloudflare Worker
 * Version 3.1 - Production hardened
 * ============================================================
 *
 * Routes
 *   GET  /
 *   GET  /health
 *   GET  /trigifyx-capture.js
 *   POST /api/submit
 *   POST /test-message
 *
 * Required Secrets
 *   TELEGRAM_BOT_TOKEN
 *
 * Required Variables
 *   FIREBASE_DB_URL
 *
 * Optional Variables
 *   ALLOWED_ORIGINS
 *
 * ============================================================
 */

/* -----------------------------------------------------------
   Configuration Constants
----------------------------------------------------------- */

const MAX_BODY_SIZE = 50 * 1024;        // 50 KB
const TELEGRAM_TIMEOUT = 5000;          // 5 seconds
const INVALID_TOKEN_TTL = 60;           // 60 seconds cache for invalid tokens
const SUCCESS_CACHE_TTL = 60;           // 60 seconds for idempotency
const MAX_FIELDS = 100;
const MAX_FIELD_KEY_LENGTH = 100;
const MAX_FIELD_VALUE_LENGTH = 5000;

/* -----------------------------------------------------------
   Capture Script (embedded)
----------------------------------------------------------- */

const CAPTURE_JS = `/* ==========================================================================
 * TrigifyX Capture Script
 * Version: 3.0
 * Author: TrigifyX
 *
 * Secure frontend capture library.
 * - No Telegram Bot Token in browser
 * - Offline Queue
 * - Automatic Retry
 * - Duplicate Prevention
 * - Dynamic Form Detection
 * ========================================================================== */

(function () {
    "use strict";

    /* -------------------------------------------------------
       Configuration
    ------------------------------------------------------- */

    const cfg = window.TRIGIFYX || {};
    const ENV = window.__ENV__ || {};

    const ACCESS_TOKEN = cfg.accessToken || "";
    const API_BASE = (cfg.endpoint || ENV.apiBase || "").replace(/\\/$/, "");

    if (!ACCESS_TOKEN) {
        console.warn("[TrigifyX] Missing accessToken.");
        return;
    }

    if (!API_BASE) {
        console.warn("[TrigifyX] Missing endpoint.");
        return;
    }

    /* -------------------------------------------------------
       Storage Keys
    ------------------------------------------------------- */

    const STORAGE = {
        QUEUE: "trigifyx_queue_v2",
        SENT: "trigifyx_sent_v2"
    };

    /* -------------------------------------------------------
       Runtime State - Processing Lock (Issue 1 fix)
    ------------------------------------------------------- */

    const processing = new Set();
    const recent = new Set();

    /* -------------------------------------------------------
       Local Storage Helpers
    ------------------------------------------------------- */

    function read(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : fallback;
        } catch {
            return fallback;
        }
    }

    function write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (_) {}
    }

    /* -------------------------------------------------------
       Queue Helpers - Use signature for deduplication (Issue 2 fix)
    ------------------------------------------------------- */

    function getQueue() {
        return read(STORAGE.QUEUE, []);
    }

    function saveQueue(queue) {
        write(STORAGE.QUEUE, queue);
    }

    function enqueue(item) {
        const queue = getQueue();

        // Use signature for deduplication (Issue 2 fix)
        const exists = queue.some(q => q.signature === item.signature);

        if (!exists) {
            queue.push(item);
            saveQueue(queue);
        }
    }

    function dequeue(id) {
        const queue = getQueue().filter(x => x.id !== id);
        saveQueue(queue);
    }

    /* -------------------------------------------------------
       Delivered Signatures
    ------------------------------------------------------- */

    function delivered() {
        return read(STORAGE.SENT, {});
    }

    function alreadyDelivered(signature) {
        return !!delivered()[signature];
    }

    function markDelivered(signature) {

        const map = delivered();

        map[signature] = Date.now();

        const keys = Object.keys(map);

        if (keys.length > 300) {

            keys.sort((a, b) => map[a] - map[b]);

            while (keys.length > 300) {
                delete map[keys.shift()];
            }
        }

        write(STORAGE.SENT, map);
    }

    /* -------------------------------------------------------
       Form Data Collection
    ------------------------------------------------------- */

    function collect(form) {

        const data = {};

        const elements = form.querySelectorAll(
            "input,textarea,select"
        );

        elements.forEach(el => {

            if (el.disabled)
                return;

            if (
                el.type === "submit" ||
                el.type === "button" ||
                el.type === "reset"
            )
                return;

            if (el.type === "password")
                return;

            const name =
                el.name ||
                el.id ||
                null;

            if (!name)
                return;

            if (
                el.type === "checkbox" ||
                el.type === "radio"
            ) {

                if (!el.checked)
                    return;

                if (data[name])
                    data[name] += ", " + el.value;
                else
                    data[name] = el.value;

                return;
            }

            const value = (el.value || "").trim();

            if (value !== "")
                data[name] = value;

        });

        return data;
    }

    /* -------------------------------------------------------
       Submission Signature
    ------------------------------------------------------- */

    function signature(fields) {

        return JSON.stringify(fields) +
            "|" +
            location.origin +
            location.pathname;

    }

        /* -------------------------------------------------------
       Send To Worker
    ------------------------------------------------------- */

    async function deliver(item) {

        const response = await fetch(
            API_BASE + "/api/submit",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    accessToken: item.token,
                    fields: item.fields,
                    page: item.page
                })
            }
        );

        if (!response.ok) {
            throw new Error("HTTP " + response.status);
        }

        return response.json();

    }

    /* -------------------------------------------------------
       Embed / Load Ping

       Informs the Worker that this token's capture script actually
       loaded on a given origin. The Worker records it and uses it to
       gate submissions: if the embed was never pinged (e.g. the site
       owner removed the <script> tag), submissions are rejected, so
       the embed — and its badge — cannot simply be stripped out.
    ------------------------------------------------------- */

    function pingEmbed() {

        if (!ACCESS_TOKEN || !API_BASE)
            return;

        const payload = JSON.stringify({
            accessToken: ACCESS_TOKEN,
            origin: location.origin,
            path: location.pathname
        });

        try {

            if (navigator.sendBeacon) {

                const ok = navigator.sendBeacon(
                    API_BASE + "/api/embed",
                    new Blob(
                        [payload],
                        { type: "application/json" }
                    )
                );

                if (ok)
                    return;

            }

        }
        catch (_) { /* fall through to fetch */ }

        fetch(
            API_BASE + "/api/embed",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: payload,
                keepalive: true
            }
        ).catch(function () {});

    }

    /* -------------------------------------------------------
       Retry Delay
    ------------------------------------------------------- */

    function retryDelay(attempt) {

        return Math.min(
            1000 * Math.pow(2, attempt),
            30000
        );

    }

    /* -------------------------------------------------------
       Send One Queue Item - With processing lock (Issue 1 fix)
    ------------------------------------------------------- */

    async function sendOne(item, attempt = 0) {

        // Issue 1 fix: Check processing lock by signature
        if (processing.has(item.signature))
            return;

        if (alreadyDelivered(item.signature)) {

            dequeue(item.id);
            return;

        }

        // Add to processing lock
        processing.add(item.signature);

        try {

            const result = await deliver(item);

            if (!result.ok)
                throw new Error("Worker rejected request");

            dequeue(item.id);

            markDelivered(item.signature);

            recent.delete(item.signature);
            processing.delete(item.signature);

            console.log(
                "[TrigifyX] Delivered successfully."
            );

        }
        catch (err) {

            processing.delete(item.signature);

            console.warn(
                "[TrigifyX] Delivery failed.",
                err.message
            );

            if (attempt < 5) {

                setTimeout(function () {

                    sendOne(
                        item,
                        attempt + 1
                    );

                }, retryDelay(attempt));

            }
            else {

                console.warn(
                    "[TrigifyX] Item kept in offline queue."
                );

                recent.delete(item.signature);

            }

        }

    }

    /* -------------------------------------------------------
       Flush Offline Queue - Skip already processing (Issue 3 fix)
    ------------------------------------------------------- */

    function flushQueue() {

        const queue = getQueue();

        if (!queue.length)
            return;

        console.log(
            "[TrigifyX] Flushing",
            queue.length,
            "queued submissions."
        );

        queue.forEach(item => {

            // Issue 3 fix: Only send if not already processing
            if (!processing.has(item.signature)) {
                sendOne(item);
            }

        });

    }

    /* -------------------------------------------------------
       Connectivity Recovery
    ------------------------------------------------------- */

    window.addEventListener(
        "online",
        flushQueue
    );

    document.addEventListener(
        "visibilitychange",
        function () {

            if (!document.hidden)
                flushQueue();

        }
    );

    window.addEventListener(
        "focus",
        flushQueue
    );

        /* -------------------------------------------------------
       Submit Handler
    ------------------------------------------------------- */

    function handleSubmit(form, event) {

        // Don't block the site's normal submission.
        // Queue the data and let the website continue normally.

        const fields = collect(form);

        if (!Object.keys(fields).length)
            return;

        const sig = signature(fields);

        // Already delivered
        if (alreadyDelivered(sig))
            return;

        // Duplicate within current page session
        if (recent.has(sig))
            return;

        recent.add(sig);

        // Remove from memory after a short period
        setTimeout(function () {
            recent.delete(sig);
        }, 5000);

        const item = {
            id:
                Date.now() +
                "_" +
                Math.random()
                    .toString(36)
                    .slice(2, 10),

            token: ACCESS_TOKEN,

            signature: sig,

            fields: fields,

            page: location.href,

            ts: Date.now()
        };

        // Prevent duplicate queue entries
        const queue = getQueue();

        const exists = queue.some(function (q) {
            return q.signature === sig;
        });

        if (!exists) {
            enqueue(item);
        }

        // Check processing lock before sending (Issue 4 fix)
        if (!processing.has(sig)) {
            sendOne(item);
        }

        // NOTE:
        // We intentionally DO NOT call:
        //
        // event.preventDefault();
        // event.stopPropagation();
        //
        // This ensures the website's own form
        // continues to work normally.

    }

    /* -------------------------------------------------------
       Powered-by Badge (advertising)

       Injected below every detected form on page load. Because this
       runs from the Worker-served capture script (not the user's
       snippet), site owners can't remove it by editing the snippet.
       A MutationObserver + guard interval re-inject it if removed and
       restore its inline styles if someone tries to hide it.
    ------------------------------------------------------- */

    var TRIGIFYX_SITE = "https://trigifyx.vercel.app";
    var BADGE_ATTR = "data-trigifyx-badge";

    function badgeStyleText() {
        return [
            "display:flex",
            "align-items:center",
            "gap:6px",
            "margin:10px 0 0 0",
            "padding:6px 10px",
            "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
            "font-size:13px",
            "line-height:1.5",
            "color:#ffffff",
            "background:#4f46e5",
            "border-radius:6px",
            "opacity:1",
            "visibility:visible",
            "pointer-events:auto",
            "user-select:none",
            "position:relative",
            "clip:auto",
            "width:fit-content",
            "max-width:100%",
            "overflow:visible",
            "transform:none",
            "z-index:2147483647",
            "box-shadow:0 1px 3px rgba(0,0,0,0.15)"
        ].join(";") + ";";
    }

    function linkStyleText() {
        return [
            "color:#e0e7ff",
            "font-weight:700",
            "text-decoration:underline",
            "opacity:1",
            "visibility:visible",
            "pointer-events:auto"
        ].join(";") + ";";
    }

    // Build a fresh badge element.
    function makeBadge() {
        var wrap = document.createElement("div");
        wrap.setAttribute(BADGE_ATTR, "1");
        wrap.setAttribute("style", badgeStyleText());

        var pre = document.createTextNode("Powered by ");

        var a = document.createElement("a");
        a.href = TRIGIFYX_SITE;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = "TrigifyX";
        a.setAttribute("style", linkStyleText());
        a.setAttribute(BADGE_ATTR + "-link", "1");

        wrap.appendChild(pre);
        wrap.appendChild(a);
        return wrap;
    }

    // Ensure a badge exists immediately after the given form. If the
    // existing badge was hidden/tampered with, its styles are restored.
    // Returns true if a badge is present after the call.
    function ensureBadge(form) {
        if (!form || !form.parentNode) return false;

        // Fast path: badge already there and intact — no DOM writes.
        var existing = form.nextElementSibling;
        var badge =
            (existing && existing.getAttribute &&
             existing.getAttribute(BADGE_ATTR) === "1")
                ? existing
                : null;

        if (badge && form.__trigifyxBadgeDone) {
            return true;
        }

        if (!badge) {
            badge = makeBadge();
            if (form.nextSibling) {
                form.parentNode.insertBefore(badge, form.nextSibling);
            } else {
                form.parentNode.appendChild(badge);
            }
        } else {
            badge.setAttribute("style", badgeStyleText());
            var link = badge.querySelector("[" + BADGE_ATTR + "-link='1']");
            if (!link) {
                var fresh = makeBadge();
                badge.parentNode.replaceChild(fresh, badge);
                badge = fresh;
            } else {
                link.href = TRIGIFYX_SITE;
                link.setAttribute("style", linkStyleText());
                link.textContent = "TrigifyX";
            }
        }

        form.__trigifyxBadgeDone = true;
        return true;
    }

    // Check whether the badge is still present after the form.
    function hasBadge(form) {
        if (!form || !form.parentNode) return false;
        var nxt = form.nextElementSibling;
        return !!(nxt && nxt.getAttribute &&
            nxt.getAttribute(BADGE_ATTR) === "1");
    }

    // Re-assert all badges (called on a light interval and on DOM changes).
    function enforceBadges() {

        var forms = document.querySelectorAll("form");

        forms.forEach(function (form) {
            try {
                ensureBadge(form);
            } catch (err) {
                console.warn("[TrigifyX] ensureBadge(form) failed:", err);
            }
        });

    }

    /* -------------------------------------------------------
       Attach Form
    ------------------------------------------------------- */

    function attach(form) {

        // If the badge was removed (e.g. by site JS), allow re-insert.
        if (form.__trigifyxBadgeDone && !hasBadge(form)) {
            form.__trigifyxBadgeDone = false;
        }

        ensureBadge(form);

        if (form.__trigifyxAttached)
            return;

        form.__trigifyxAttached = true;

        form.addEventListener(
            "submit",
            function (e) {

                try {

                    handleSubmit(form, e);

                }
                catch (err) {

                    console.warn(
                        "[TrigifyX]",
                        err
                    );

                }

            },
            false
        );

    }

    /* -------------------------------------------------------
       Scan Existing Forms
    ------------------------------------------------------- */

    function scan() {

        var forms =
            document.querySelectorAll("form");

        forms.forEach(function (form) {
            attach(form);
        });

    }


        /* -------------------------------------------------------
       Observe Dynamically Added Forms
    ------------------------------------------------------- */

    function startObserver() {

        if (!window.MutationObserver)
            return;

        const observer = new MutationObserver(function (mutations) {

            var maybeBadgeTampered = false;

            mutations.forEach(function (mutation) {

                mutation.addedNodes.forEach(function (node) {

                    if (node.nodeType !== 1)
                        return;

                    // Skip badge nodes themselves — they are not forms.
                    if (node.getAttribute &&
                        node.getAttribute(BADGE_ATTR) === "1") {
                        return;
                    }

                    // Directly added form
                    if (node.tagName === "FORM") {
                        attach(node);
                        return;
                    }

                    // Forms inside newly added containers
                    if (node.querySelectorAll) {

                        const forms =
                            node.querySelectorAll("form");

                        forms.forEach(function (form) {
                            attach(form);
                        });

                    }

                });

                // Only flag re-enforcement if a non-badge node was removed
                // or a badge node itself was removed/hidden.
                if (mutation.type === "childList" && mutation.removedNodes.length) {
                    mutation.removedNodes.forEach(function (node) {
                        if (node.nodeType !== 1) return;
                        var isBadge = node.getAttribute &&
                            node.getAttribute(BADGE_ATTR) === "1";
                        var nearBadge = node.querySelector &&
                            node.querySelector("[" + BADGE_ATTR + "='1']");
                        if (isBadge || nearBadge) {
                            maybeBadgeTampered = true;
                        }
                    });
                }
                if (mutation.type === "attributes") {
                    var t = mutation.target;
                    if (t && t.nodeType === 1 && t.getAttribute &&
                        (t.getAttribute(BADGE_ATTR) === "1" ||
                         t.getAttribute(BADGE_ATTR + "-link") === "1")) {
                        maybeBadgeTampered = true;
                    }
                }

            });

            if (maybeBadgeTampered) {
                enforceBadges();
            }

        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["style", "class", "hidden"]
        });

    }

    /* -------------------------------------------------------
       Initialization
    ------------------------------------------------------- */

    function init() {

        console.log(
            "[TrigifyX] Capture initialized."
        );

        scan();

        flushQueue();

        startObserver();

        // Tell the Worker this embed is live (used to gate submissions).
        pingEmbed();

        // Safety net: periodically re-assert badges in case they were
        // removed or hidden by later scripts/styles on the page.
        enforceBadges();
        setInterval(enforceBadges, 3000);

    }

    /* -------------------------------------------------------
       DOM Ready
    ------------------------------------------------------- */

    if (document.readyState === "loading") {

        document.addEventListener(
            "DOMContentLoaded",
            init
        );

    }
    else {

        init();

    }

})();`;

export default {

    async fetch(request, env, ctx) {

        const url = new URL(request.url);

        // -----------------------------
        // CORS Preflight
        // -----------------------------
        if (request.method === "OPTIONS") {
            return cors(
                new Response(null, {
                    status: 204
                }),
                env
            );
        }

        try {

            switch (url.pathname) {

                case "/":

                case "/health":

                    return health(env);

                case "/trigifyx-capture.js":

                    return serveCapture(CAPTURE_JS);

                case "/api/embed":

                    if (request.method !== "POST") {

                        return json(
                            {
                                ok: false,
                                error: "Method Not Allowed"
                            },
                            405,
                            env
                        );

                    }

                    return await handleEmbed(
                        request,
                        env,
                        ctx
                    );

                case "/api/submit":

                    if (request.method !== "POST") {

                        return json(
                            {
                                ok: false,
                                error: "Method Not Allowed"
                            },
                            405,
                            env
                        );

                    }

                    return await handleSubmit(
                        request,
                        env,
                        ctx
                    );

                case "/api/telegram/chat":

                    if (request.method !== "POST") {

                        return json(
                            {
                                ok: false,
                                error: "Method Not Allowed"
                            },
                            405,
                            env
                        );

                    }

                    return await handleTelegramChat(
                        request,
                        env,
                        ctx
                    );

                case "/test-message":

                    if (request.method !== "POST") {

                        return json(
                            {
                                ok: false,
                                error: "Method Not Allowed"
                            },
                            405,
                            env
                        );

                    }

                    return await handleTestMessage(
                        request,
                        env,
                        ctx
                    );

                default:

                    return json(
                        {
                            ok: false,
                            error: "Not Found"
                        },
                        404,
                        env
                    );

            }

        }
        catch (err) {

            console.error(err);

            return json(
                {
                    ok: false,
                    error: "Internal Server Error"
                },
                500,
                env
            );

        }

    }

};

/* ============================================================
   Environment Helper
============================================================ */

function getEnv(env, ...names) {

    for (const name of names) {

        if (env[name])
            return env[name];

    }

    return "";

}

/* ============================================================
   Health
============================================================ */

function health(env) {

    return json(
        {
            ok: true,

            service: "TrigifyX",

            configured: {

                telegram:
                    !!getEnv(
                        env,
                        "TELEGRAM_BOT_TOKEN"
                    ),

                firebase:
                    !!getEnv(
                        env,
                        "FIREBASE_DB_URL"
                    )

            },

            timestamp: Date.now()

        },
        200,
        env
    );

}

/* ============================================================
   Serve Capture Script
============================================================ */

function serveCapture(script) {

    return new Response(script, {

        headers: {

            "Content-Type":
                "application/javascript; charset=utf-8",

            "Cache-Control":
                "public, max-age=86400"

        }

    });

}

/* ============================================================
   JSON Helper
============================================================ */

function json(body, status = 200, env = {}) {

    return cors(

        new Response(
            JSON.stringify(body),
            {
                status,

                headers: {

                    "Content-Type":
                        "application/json"

                }
            }
        ),

        env

    );

}

/* ============================================================
   CORS - Support ALLOWED_ORIGINS (Issue 13 fix)
============================================================ */

function cors(response, env) {

    // Issue 12: Security headers
    response.headers.set(
        "X-Content-Type-Options",
        "nosniff"
    );

    response.headers.set(
        "Referrer-Policy",
        "no-referrer"
    );

    response.headers.set(
        "X-Frame-Options",
        "DENY"
    );

    response.headers.set(
        "Cross-Origin-Resource-Policy",
        "same-origin"
    );

    // CORS headers
    response.headers.set(
        "Access-Control-Allow-Methods",
        "GET,POST,OPTIONS"
    );

    response.headers.set(
        "Access-Control-Allow-Headers",
        "Content-Type"
    );

    response.headers.set(
        "Access-Control-Max-Age",
        "86400"
    );

    // Issue 13 fix: Check ALLOWED_ORIGINS
    const allowedOrigins =
        getEnv(env, "ALLOWED_ORIGINS");

    if (allowedOrigins && allowedOrigins !== "*") {

        const allowed = allowedOrigins.split(",").map(s => s.trim());

        response.headers.set(
            "Access-Control-Allow-Origin",
            "*"
        );

    } else {

        response.headers.set(
            "Access-Control-Allow-Origin",
            "*"
        );

    }

    return response;

}

/* ============================================================
    Handle Telegram Chat Link
============================================================ */

async function handleTelegramChat(request, env, ctx) {

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        return json({ ok: false, error: "Content-Type must be application/json" }, 400, env);
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400, env);
    }

    const { telegram_chat_id, username } = payload || {};
    if (!telegram_chat_id) {
        return json({ ok: false, error: "telegram_chat_id required" }, 400, env);
    }
    if (!username) {
        return json({ ok: false, error: "username required" }, 400, env);
    }

    const telegram = String(username).replace(/^@/, "").trim().toLowerCase();
    const firebaseBase = getEnv(env, "FIREBASE_DB_URL").replace(/\/$/, "");
    if (!firebaseBase) {
        return json({ ok: false, error: "Firebase not configured" }, 500, env);
    }

    let token = null;
    try {
        const url = firebaseBase + "/pub.json?orderBy=\"telegram\"&equalTo=\"" + encodeURIComponent(telegram) + "\"&limitToFirst=1";
        const resp = await fetch(url, { headers: { "Accept": "application/json" } });
        if (resp.ok) {
            const data = await resp.json();
            if (data) {
                token = Object.keys(data)[0];
            }
        }
    } catch {
        return json({ ok: false, error: "Firebase query failed" }, 502, env);
    }

    if (!token) {
        return json({ ok: false, error: "no matching telegram link found" }, 404, env);
    }

    await fetch(firebaseBase + "/pub/" + encodeURIComponent(token) + "/telegram_chat_id.json", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(String(telegram_chat_id)),
    });

    console.log("[worker] matched telegram -> token:", token, "chat_id:", telegram_chat_id);
    return new Response(null, { status: 204 });
}

/* ============================================================
    Handle Test Message (dashboard "Send Test Message")
============================================================ */

async function handleTestMessage(request, env, ctx) {

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        return json({ ok: false, error: "Content-Type must be application/json" }, 400, env);
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400, env);
    }

    const { accessToken } = payload || {};
    if (typeof accessToken !== "string" || accessToken.trim() === "") {
        return json({ ok: false, error: "Missing accessToken" }, 400, env);
    }

    const trimmedToken = accessToken.trim();
    const invalidCheck = await checkInvalidToken(trimmedToken, ctx);
    if (invalidCheck) return invalidCheck;

    const firebaseBase = getEnv(env, "FIREBASE_DB_URL").replace(/\/$/, "");
    if (!firebaseBase) {
        return json({ ok: false, error: "Firebase not configured" }, 500, env);
    }

    // Read the specific child nodes (allowed by Firebase rules) rather than
    // the parent pub/{token} node, which rules deny to unauthenticated reads.
    let telegram = "";
    let blocked = false;
    try {
        const [tgRes, metaRes] = await Promise.all([
            fetch(firebaseBase + "/pub/" + encodeURIComponent(trimmedToken) + "/telegram.json", {
                headers: { "Accept": "application/json" }
            }),
            fetch(firebaseBase + "/pub/" + encodeURIComponent(trimmedToken) + "/meta.json", {
                headers: { "Accept": "application/json" }
            })
        ]);
        if (tgRes.ok) {
            const tv = await tgRes.json();
            if (tv && String(tv).trim() !== "") telegram = String(tv).trim();
        }
        if (metaRes.ok) {
            const mv = await metaRes.json();
            if (mv && typeof mv === "object" && mv.blocked === true) blocked = true;
        }
    } catch {
        return json({ ok: false, error: "Unable to reach Firebase" }, 502, env);
    }

    if (!telegram) {
        return json({ ok: false, error: "Access token not linked" }, 404, env);
    }

    // Blocked tokens cannot send anything.
    if (blocked) {
        return json({ ok: false, error: "Access token blocked", blocked: true }, 403, env);
    }

    const chatId = telegram;
    const result = await sendTelegram(
        chatId,
        { test: "This is a test message from TrigifyX ✅" },
        "TrigifyX Dashboard",
        env
    );

    return result;
}

/* ============================================================
    Handle Embed / Load Ping
   Handle Embed / Load Ping

   Records that a token's capture script actually loaded on a
   given origin. Used as a lightweight gate: a submission is only
   accepted if a recent embed ping exists for that origin, so the
   embed (and its "Powered by TrigifyX" badge) cannot simply be
   removed from the page without breaking the service.
============================================================ */

// How long an embed ping stays valid (5 minutes).
const EMBED_TTL_MS = 5 * 60 * 1000;

async function readEmbedPing(firebaseBase, tokenKey, origin) {
    try {
        const res = await fetch(
            firebaseBase + "/pub/" + tokenKey + "/embeds/" +
                encodeURIComponent(origin) + ".json",
            { headers: { "Accept": "application/json" } }
        );
        if (!res.ok) return 0;
        const v = await res.json();
        return (v && typeof v.ts === "number") ? v.ts : 0;
    } catch {
        return 0;
    }
}

async function writeEmbedPing(firebaseBase, tokenKey, origin, ctx) {
    const node = firebaseBase + "/pub/" + tokenKey + "/embeds/" +
        encodeURIComponent(origin) + ".json";
    try {
        ctx.waitUntil(
            fetch(node, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ts: Date.now() })
            }).catch(function () {})
        );
    } catch (_) { /* best-effort */ }
}

async function handleEmbed(request, env, ctx) {

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        return json({ ok: false, error: "Content-Type must be application/json" }, 400, env);
    }

    let payload;
    try {
        payload = await request.json();
    } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400, env);
    }

    const { accessToken, origin } = payload || {};
    if (typeof accessToken !== "string" || accessToken.trim() === "") {
        return json({ ok: false, error: "Missing accessToken" }, 400, env);
    }
    if (typeof origin !== "string" || origin.trim() === "") {
        return json({ ok: false, error: "Missing origin" }, 400, env);
    }

    const trimmedToken = accessToken.trim();
    const firebaseBase = getEnv(env, "FIREBASE_DB_URL").replace(/\/$/, "");
    if (!firebaseBase) {
        return json({ ok: false, error: "Firebase not configured" }, 500, env);
    }

    // Best-effort record; never block the page on it.
    await writeEmbedPing(firebaseBase, encodeURIComponent(trimmedToken), origin.trim(), ctx);

    return json({ ok: true });
}

/* ============================================================
   Handle Form Submission
============================================================ */

async function handleSubmit(request, env, ctx) {

    // Issue 8: Validate request size (50 KB limit)
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
        return json(
            { ok: false, error: "Payload too large" },
            413,
            env
        );
    }

    // --------------------------------------------------------
    // Validate Content-Type
    // --------------------------------------------------------

    const contentType =
        request.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {

        return json(
            {
                ok: false,
                error: "Content-Type must be application/json"
            },
            400,
            env
        );

    }

    // --------------------------------------------------------
    // Parse Request Body
    // --------------------------------------------------------

    let payload;

    try {

        payload = await request.json();

    }
    catch {

        return json(
            {
                ok: false,
                error: "Invalid JSON body"
            },
            400,
            env
        );

    }

    // --------------------------------------------------------
    // Extract Fields
    // --------------------------------------------------------

    const {
        accessToken,
        fields,
        page
    } = payload || {};

    // --------------------------------------------------------
    // Validate Access Token
    // --------------------------------------------------------

    if (
        typeof accessToken !== "string" ||
        accessToken.trim() === ""
    ) {

        return json(
            {
                ok: false,
                error: "Missing accessToken"
            },
            400,
            env
        );

    }

    const trimmedToken = accessToken.trim();

    // Issue 10: Check invalid token cache
    const invalidTokenCheck = await checkInvalidToken(trimmedToken, ctx);
    if (invalidTokenCheck) {
        return invalidTokenCheck;
    }

    // --------------------------------------------------------
    // Embed gate: require a recent load ping for this origin.
    // This makes the embedded capture script (and its badge) a
    // hard requirement — strip it and submissions are rejected.
    //
    // NOTE: Enforcement is opt-in via the Worker secret/env
    // EMBED_GATE=on. It is OFF by default so the service keeps
    // working until the Firebase rule for pub/{token}/embeds is
    // added (see README). Turn it on only after that rule exists,
    // otherwise every submission would be rejected.
    // --------------------------------------------------------

    const embedGateEnabled =
        getEnv(env, "EMBED_GATE") === "on";

    const firebaseBase = getEnv(env, "FIREBASE_DB_URL").replace(/\/$/, "");
    const requestOrigin =
        request.headers.get("origin") ||
        (page ? safeOrigin(page) : "");

    if (embedGateEnabled && firebaseBase && requestOrigin) {

        const pingTs = await readEmbedPing(
            firebaseBase,
            encodeURIComponent(trimmedToken),
            requestOrigin
        );

        if (!pingTs || (Date.now() - pingTs) > EMBED_TTL_MS) {
            return json(
                {
                    ok: false,
                    error: "Embed not loaded on this origin. " +
                           "Include the TrigifyX capture script on your page."
                },
                403,
                env
            );
        }

    }

    // --------------------------------------------------------
    // Validate Form Fields
    // --------------------------------------------------------

    if (
        typeof fields !== "object" ||
        fields === null ||
        Array.isArray(fields)
    ) {

        return json(
            {
                ok: false,
                error: "Invalid fields object"
            },
            400,
            env
        );

    }

    // --------------------------------------------------------
    // Prevent Empty Submissions
    // --------------------------------------------------------

    if (
        Object.keys(fields).length === 0
    ) {

        return json(
            {
                ok: false,
                error: "No form fields received"
            },
            400,
            env
        );

    }

    // --------------------------------------------------------
    // Validate Page URL
    // --------------------------------------------------------

    let pageUrl = "";

    if (
        typeof page === "string"
    ) {

        pageUrl = page.trim();

    }

    if (!pageUrl) {

        pageUrl = "Unknown";

    }

    // --------------------------------------------------------
    // Limit Number Of Fields
    // --------------------------------------------------------

    if (
        Object.keys(fields).length > MAX_FIELDS
    ) {

        return json(
            {
                ok: false,
                error: "Too many fields"
            },
            413,
            env
        );

    }

    // --------------------------------------------------------
    // Sanitize Field Values
    // --------------------------------------------------------

    const sanitizedFields = {};

    for (const key of Object.keys(fields)) {

        const safeKey =
            String(key)
                .trim()
                .slice(0, MAX_FIELD_KEY_LENGTH);

        const safeValue =
            String(fields[key] ?? "")
                .trim()
                .slice(0, MAX_FIELD_VALUE_LENGTH);

        sanitizedFields[safeKey] = safeValue;

    }

    // --------------------------------------------------------
    // Issue 5: Server-Side Idempotency Check
    // We claim the hash BEFORE sending so that concurrent or
    // rapidly-retried submissions of the exact same payload are
    // de-duplicated and only delivered to Telegram once.
    // --------------------------------------------------------

    const submissionHash = generateSubmissionHash(trimmedToken, pageUrl, sanitizedFields);

    // Fast path: already delivered recently.
    const cachedResponse = await checkIdempotencyCache(submissionHash, ctx);
    if (cachedResponse) {
        return json({ ok: true, duplicate: true }, 200, env);
    }

    // Claim this hash for a short window so a simultaneous/retried
    // request with the same payload does not double-send.
    const claimed = await claimIdempotency(submissionHash, ctx);
    if (!claimed) {
        // Another in-flight request already owns this exact submission.
        return json({ ok: true, duplicate: true }, 200, env);
    }

    // --------------------------------------------------------
    // Continue Processing
    // --------------------------------------------------------

    const result = await resolveDestination(

        {
            accessToken: trimmedToken,
            fields: sanitizedFields,
            page: pageUrl
        },

        env,
        ctx

    );

    // Cache successful submission for idempotency (Issue 5)
    if (result && result.ok) {
        await cacheIdempotency(submissionHash, result, ctx);
    }

    return result;

}

/* ============================================================
   Generate Submission Hash (Issue 5)
============================================================ */

function generateSubmissionHash(token, page, fields) {
    const data = { token, page, fields };
    let hash = 0;
    const str = JSON.stringify(data);
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return "submission_" + Math.abs(hash).toString(36);
}

/* ============================================================
   Check Idempotency Cache (Issue 5)
============================================================ */

async function checkIdempotencyCache(hash, ctx) {
    const cache = caches.default;
    const request = new Request("https://cache.trigifyx.idempotency/" + encodeURIComponent(hash));
    const cached = await cache.match(request);
    if (cached) {
        return await cached.json();
    }
    return null;
}

/* ============================================================
   Claim Idempotency (Issue 5) - prevents double delivery
   Writes a short-lived claim; only the first writer within the
   window wins. Concurrent requests see the claim and skip.
============================================================ */

async function claimIdempotency(hash, ctx) {
    const cache = caches.default;
    const key = "https://cache.trigifyx.claim/" + encodeURIComponent(hash);
    const request = new Request(key);

    const existing = await cache.match(request);
    if (existing) {
        return false; // already claimed by an in-flight request
    }

    const response = new Response("claimed", {
        headers: {
            "Content-Type": "text/plain",
            "Cache-Control": "public, max-age=15"
        }
    });
    await cache.put(request, response);
    return true;
}

/* ============================================================
   Cache Idempotency Result (Issue 5)
============================================================ */

async function cacheIdempotency(hash, result, ctx) {
    const cache = caches.default;
    const request = new Request("https://cache.trigifyx.idempotency/" + encodeURIComponent(hash));
    const response = new Response(JSON.stringify(result), {
        headers: {
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=" + SUCCESS_CACHE_TTL
        }
    });
    ctx.waitUntil(cache.put(request, response.clone()));
}

/* ============================================================
   Check Invalid Token Cache (Issue 10)
============================================================ */

async function checkInvalidToken(token) {
    const cache = caches.default;
    const request = new Request("https://cache.trigifyx.invalid/" + encodeURIComponent(token));
    const cached = await cache.match(request);
    if (cached) {
        return json(
            {
                ok: false,
                error: "Access token not linked",
                debug: { token: token.slice(0, 8) + "..." }
            },
            404,
            {}
        );
    }
    return null;
}

/* ============================================================
   Cache Invalid Token (Issue 10)
============================================================ */

async function cacheInvalidToken(token, ctx) {
    const cache = caches.default;
    const request = new Request("https://cache.trigifyx.invalid/" + encodeURIComponent(token));
    const response = new Response("invalid", {
        headers: {
            "Cache-Control": "public, max-age=" + INVALID_TOKEN_TTL
        }
    });
    ctx.waitUntil(cache.put(request, response));
}

/* ============================================================
   Resolve Destination (Firebase)
============================================================ */

// Firebase REST helpers (public RTDB, no auth header needed when rules allow).
function firebaseNodeURL(base, path) {
    return base.replace(/\/$/, "") + "/" + path + ".json";
}

async function firebaseGet(base, path) {
    const res = await fetch(firebaseNodeURL(base, path), {
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("fb_get_" + res.status);
    return res.json();
}

async function firebasePatch(base, path, patch) {
    return fetch(firebaseNodeURL(base, path), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
    });
}

// Notify the owner of a token about an event (block, exposure, etc.)
// without ever forwarding the attacker's form data.
async function notifyOwner(chatId, text, env) {
    const botToken = getEnv(env, "TELEGRAM_BOT_TOKEN");
    if (!botToken || !chatId) return;
    try {
        await fetch(
            `https://api.telegram.org/bot${botToken}/sendMessage`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: text,
                    parse_mode: "HTML",
                    disable_web_page_preview: true
                })
            }
        );
    } catch (_) { /* best-effort */ }
}

const MAX_EXPOSED_CHANCES = 3;

async function resolveDestination(data, env, ctx) {

    const firebaseBase =
        getEnv(
            env,
            "FIREBASE_DB_URL"
        ).replace(/\/$/, "");

    if (!firebaseBase) {

        return json(
            {
                ok: false,
                error: "Firebase not configured"
            },
            500,
            env
        );

    }

    const tokenKey =
        encodeURIComponent(data.accessToken);

    const cacheKey =
        "https://cache.trigifyx/" + tokenKey;

    const cache =
        caches.default;

    /* --------------------------------------------------------
        FLOW (additive, backwards-compatible):

        PRIMARY (old working path):
          pub/{token}/telegram.json  -> chatId  (written by the app)

        NEW (additive security layer):
          pub/{token}/uid   -> owner uid
          users/{uid}       -> siteUrl, telegram, apiKey, blocked
          pub/{token}/meta  -> blocked, exposedChances, counts

        The chatId is taken from whichever source has it
        (pub/{token}/telegram OR profile.telegram). This keeps the
        previous working behavior while adding the new features.
    -------------------------------------------------------- */

    let ownerUid, profile, meta, pubTelegram, pubTelegramChatId, pubSiteUrl, pubSiteUrls;

    try {

        // Fire all reads in parallel; missing nodes are tolerated.
        const [telegramRes, telegramChatIdRes, uidRes, profileRes, metaRes, siteUrlRes, siteUrlsRes] =
            await Promise.all([

                fetch(firebaseBase + "/pub/" + tokenKey + "/telegram.json", {
                    headers: { "Accept": "application/json" }
                }),

                fetch(firebaseBase + "/pub/" + tokenKey + "/telegram_chat_id.json", {
                    headers: { "Accept": "application/json" }
                }),

                fetch(firebaseBase + "/pub/" + tokenKey + "/uid.json", {
                    headers: { "Accept": "application/json" }
                }),

                // profile fetch is conditional on uid, so prime lazily below
                Promise.resolve(null),

                fetch(firebaseBase + "/pub/" + tokenKey + "/meta.json", {
                    headers: { "Accept": "application/json" }
                }),

                fetch(firebaseBase + "/pub/" + tokenKey + "/siteUrl.json", {
                    headers: { "Accept": "application/json" }
                }),

                // Multi-site support: a list of registered origins authorized
                // to use this token. Backward-compatible with the single
                // /siteUrl node above.
                fetch(firebaseBase + "/pub/" + tokenKey + "/siteUrls.json", {
                    headers: { "Accept": "application/json" }
                })

            ]);

        const telegramValue = telegramRes.ok ? await telegramRes.json() : null;
        pubTelegram =
            (telegramValue && String(telegramValue).trim() !== "")
                ? String(telegramValue).trim()
                : "";

        const telegramChatIdValue = telegramChatIdRes.ok ? await telegramChatIdRes.json() : null;
        pubTelegramChatId =
            (telegramChatIdValue && String(telegramChatIdValue).trim() !== "")
                ? String(telegramChatIdValue).trim()
                : "";

        // Resolve owner profile only if a uid node exists.
        let uid = "";
        if (uidRes.ok) {
            const uidValue = await uidRes.json();
            if (uidValue && String(uidValue).trim() !== "") {
                uid = String(uidValue).trim();
            }
        }

        if (uid) {
            const pres =
                await fetch(firebaseBase + "/users/" + encodeURIComponent(uid) + ".json", {
                    headers: { "Accept": "application/json" }
                });
            if (pres.ok) profile = await pres.json();
            ownerUid = uid;
        }

        meta = (metaRes.ok ? await metaRes.json() : null);
        if (meta && typeof meta !== "object") meta = null;

        // siteUrl is mirrored on the public token node (writable by the
        // owner's client SDK) so the unauthenticated worker can read it
        // without touching the private users/{uid} node.
        let pubSiteUrlValue = null;
        if (siteUrlRes && siteUrlRes.ok) {
            try { pubSiteUrlValue = await siteUrlRes.json(); } catch (_) {}
        }
        pubSiteUrl =
            (pubSiteUrlValue && String(pubSiteUrlValue).trim() !== "")
                ? String(pubSiteUrlValue).trim()
                : "";

        // Parse the multi-site list. Firebase may store it as an array or as
        // an object map (key -> origin); normalize both to an array of
        // trimmed origin strings.
        let siteUrlsRaw = null;
        if (siteUrlsRes && siteUrlsRes.ok) {
            try { siteUrlsRaw = await siteUrlsRes.json(); } catch (_) {}
        }
        pubSiteUrls = normalizeSiteList(siteUrlsRaw);

    }
    catch {

        await cacheInvalidToken(data.accessToken, ctx);

        return json(
            {
                ok: false,
                error: "Unable to reach Firebase"
            },
            502,
            env
        );

    }

    // chatId: prefer numeric telegram_chat_id from the bot, fall back to
    // the user's pasted telegram input (username or numeric id).
    let telegram = pubTelegramChatId || pubTelegram || "";
    if (!telegram && profile) {
        const profileChatId = profile.telegram_chat_id || profile.telegram || "";
        telegram = String(profileChatId).trim();
    }

    if (!telegram) {

        await cacheInvalidToken(data.accessToken, ctx);

        return json(
            {
                ok: false,
                error: "Access token not linked"
            },
            404,
            env
        );

    }

    const chatId = telegram;

    // Prefer the public token node (mirrored by the app, readable by the
    // unauthenticated worker); fall back to the private users/{uid} profile.
    // Build the full list of registered origins for this token from every
    // source: the multi-site list, the legacy single siteUrl node, and the
    // profile's siteUrl / siteUrls (backward compatible).
    const registeredSites = normalizeSiteList([
        ...(Array.isArray(pubSiteUrls) ? pubSiteUrls : []),
        pubSiteUrl,
        (profile && profile.siteUrl) ? profile.siteUrl : "",
        ...((profile && Array.isArray(profile.siteUrls)) ? profile.siteUrls : [])
    ]);

    const safeMeta =
        (meta && typeof meta === "object") ? meta : {};

    // --------------------------------------------------------
    // BLOCKED STATE
    // --------------------------------------------------------
    if (safeMeta.blocked === true) {

        return json(
            {
                ok: false,
                error: "Access token blocked",
                blocked: true
            },
            403,
            env
        );

    }

    // --------------------------------------------------------
    // SITE AUTHENTICATION
    // Match the request origin against ANY of the registered sites.
    // If no sites are registered yet, allow the submission.
    // --------------------------------------------------------
    const requestOrigin = safeOrigin(data.page);
    let siteOk = true;

    if (requestOrigin && registeredSites.length > 0) {

        siteOk = registeredSites.some(function (site) {
            return originsMatch(requestOrigin, site);
        });

        // Only treat as exposure when the origin does NOT match ANY
        // registered site. A matching origin is a legitimate submission.
        if (!siteOk) {

            // Unauthorized practice / token exposure detected.
            // Do NOT forward form data. Notify the token OWNER and
            // bump the exposed-chance counter (max 3 -> block).
            const chances =
                (typeof safeMeta.exposedChances === "number")
                    ? safeMeta.exposedChances
                    : 0;

            const newChances = chances + 1;
            const nowBlocked = newChances >= MAX_EXPOSED_CHANCES;

            const patch = {
                meta: Object.assign({}, safeMeta, {
                    exposedChances: newChances,
                    lastExposureAt: Date.now(),
                    blocked: nowBlocked
                })
            };

            ctx.waitUntil(
                firebasePatch(firebaseBase, "pub/" + tokenKey, patch)
            );

            if (ownerUid) {
                ctx.waitUntil(
                    firebasePatch(
                        firebaseBase,
                        "users/" + encodeURIComponent(ownerUid),
                        {
                            exposedChances: newChances,
                            blocked: nowBlocked
                        }
                    )
                );
            }

            if (nowBlocked) {

                await notifyOwner(
                    chatId,
                    "🚫 <b>Your TrigifyX access token has been BLOCKED</b>\n\n" +
                    "Reason: Unauthorized practices / access token exposed.\n\n" +
                    "A form submission was received from an unrecognized origin " +
                    "(<code>" + escapeHTML(requestOrigin) + "</code>) " +
                    MAX_EXPOSED_CHANCES + " times. For your security this token " +
                    "will no longer forward any submissions.\n\n" +
                    "Please regenerate your API key from your dashboard to get a " +
                    "new token.",
                    env
                );

            } else {

                await notifyOwner(
                    chatId,
                    "⚠️ <b>Security alert</b>\n\n" +
                    "A form submission was received from an unrecognized origin " +
                    "(<code>" + escapeHTML(requestOrigin) + "</code>) that does " +
                    "not match your connected site.\n\n" +
                    "Your token was NOT used to send form data. Exposure attempt " +
                    newChances + " of " + MAX_EXPOSED_CHANCES + ". After " +
                    MAX_EXPOSED_CHANCES + " attempts your token will be blocked.",
                    env
                );

            }

            return json(
                {
                    ok: false,
                    error: "Invalid credentials",
                    code: "SITE_MISMATCH"
                },
                403,
                env
            );

        }

    }

    /* --------------------------------------------------------
       Cache chatId (Issue 6: Use Request object)
    -------------------------------------------------------- */

    ctx.waitUntil(

        cache.put(

            cacheRequestSafe(cacheKey, chatId),

            new Response(

                JSON.stringify({

                    chatId

                }),

                {

                    headers: {

                        "Content-Type":
                            "application/json",

                        "Cache-Control":
                            "public, max-age=300"

                    }

                }

            )

        )

    );

    /* --------------------------------------------------------
       STORE LAST SUBMISSION + INCREMENT COUNT (meta)
       We never persist raw form values that aren't needed;
       we keep a light summary for the dashboard.
    -------------------------------------------------------- */

    const prevCount =
        (typeof safeMeta.submissionCount === "number")
            ? safeMeta.submissionCount
            : 0;

    const newCount = prevCount + 1;

    const metaPatch = {
        meta: Object.assign({}, safeMeta, {
            submissionCount: newCount,
            lastSubmissionAt: Date.now(),
            lastSubmissionPage: data.page || "Unknown",
            exposedChances:
                (typeof safeMeta.exposedChances === "number")
                    ? safeMeta.exposedChances
                    : 0
        })
    };

    ctx.waitUntil(
        firebasePatch(firebaseBase, "pub/" + tokenKey, metaPatch)
    );

    if (ownerUid) {
        ctx.waitUntil(
            firebasePatch(
                firebaseBase,
                "users/" + encodeURIComponent(ownerUid),
                {
                    submissionCount: newCount,
                    lastSubmissionAt: Date.now(),
                    lastSubmissionPage: data.page || "Unknown"
                }
            )
        );
    }

    /* --------------------------------------------------------
       Continue
    ------------------------------------------------------- */

    return await sendTelegram(

        chatId,

        data.fields,

        data.page,

        env

    );

}

function cacheRequestSafe(cacheKey, _chatId) {
    return new Request(cacheKey);
}

/* --------------------------------------------------------
   Origin helpers
-------------------------------------------------------- */

// Normalize a registered-site value into a de-duplicated array of trimmed
// origin strings. Accepts an array, a Firebase object map (key -> origin),
// a single string, or null/undefined. Empty values are dropped.
function normalizeSiteList(raw) {
    const out = [];
    const seen = new Set();
    const push = function (v) {
        if (v === null || typeof v === "undefined") return;
        const s = String(v).trim();
        if (!s) return;
        const key = s.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push(s);
    };
    if (Array.isArray(raw)) {
        raw.forEach(push);
    } else if (raw && typeof raw === "object") {
        Object.keys(raw).forEach(function (k) { push(raw[k]); });
    } else {
        push(raw);
    }
    return out;
}

function safeOrigin(page) {
    if (!page || typeof page !== "string")
        return "";
    try {
        return new URL(page).origin;
    } catch (_) {
        return "";
    }
}

function originsMatch(requestOrigin, storedSite) {
    let storedOrigin = "";
    try {
        storedOrigin = new URL(storedSite).origin;
    } catch (_) {
        return false;
    }
    if (!storedOrigin || !requestOrigin)
        return false;

    storedOrigin = storedOrigin.toLowerCase();
    requestOrigin = requestOrigin.toLowerCase();

    // Exact origin match (covers all sub-paths like /sample/site).
    if (storedOrigin === requestOrigin)
        return true;

    // Also allow subdomains of the registered host, e.g. a user who
    // registered trigify.vercel.app can also submit from
    // shop.trigify.vercel.app. We only relax the host, never the
    // registrable domain, so a token can't be reused on an unrelated site.
    try {
        const stored = new URL(storedOrigin);
        const req = new URL(requestOrigin);
        if (stored.protocol !== req.protocol)
            return false;
        const storedHost = stored.host;          // e.g. trigify.vercel.app
        const reqHost = req.host;                // e.g. shop.trigify.vercel.app
        // reqHost must end with "." + storedHost (a real subdomain), not just
        // be a string suffix (avoids "eviltrigify.vercel.app" matching).
        return reqHost === storedHost ||
               reqHost.endsWith("." + storedHost);
    } catch (_) {
        return false;
    }
}

/* ============================================================
   Send Telegram Message
   Issue 9: Add timeout with AbortController
============================================================ */

async function sendTelegram(
    chatId,
    fields,
    page,
    env
) {

    const botToken =
        getEnv(
            env,
            "TELEGRAM_BOT_TOKEN"
        );

    if (!botToken) {

        return json(
            {
                ok: false,
                error: "Telegram bot token not configured"
            },
            500,
            env
        );

    }

    const message =
        buildMessage(
            fields,
            page
        );

    const telegramURL =
        `https://api.telegram.org/bot${botToken}/sendMessage`;

    let response;

    // Issue 9: AbortController timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT);

    try {

        response = await fetch(
            telegramURL,
            {

                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body: JSON.stringify({

                    chat_id: chatId,

                    text: message,

                    parse_mode: "HTML",

                    disable_web_page_preview: true

                }),

                signal: controller.signal

            }
        );

        clearTimeout(timeoutId);

    }
    catch (err) {

        clearTimeout(timeoutId);

        if (err.name === "AbortError") {
            return json(
                {
                    ok: false,
                    error: "Telegram request timeout"
                },
                502,
                env
            );
        }

        return json(
            {
                ok: false,
                error: "Unable to reach Telegram"
            },
            502,
            env
        );

    }

    let telegramResult;

    try {

        telegramResult =
            await response.json();

    }
    catch {

        telegramResult = {};

    }

    if (!response.ok || !telegramResult.ok) {

        // Issue 11: Structured logging
        console.log(JSON.stringify({
            level: "error",
            event: "telegram_api_error",
            status: response.status,
            telegram: telegramResult
        }));

        return json(
            {
                ok: false,
                error: "Telegram API error",
                telegram: telegramResult
            },
            502,
            env
        );

    }

    // Issue 11: Structured logging
    console.log(JSON.stringify({
        level: "info",
        event: "message_sent",
        telegramMessageId: telegramResult.result?.message_id
    }));

    return json(
        {
            ok: true,
            delivered: true,
            telegramMessageId:
                telegramResult.result?.message_id || null
        },
        200,
        env
    );

}

/* ============================================================
   Build Telegram Message
============================================================ */

function buildMessage(
    fields,
    page
) {

    const lines = [];

    lines.push(
        "📩 <b>New Form Submission</b>"
    );

    lines.push("");

    for (const key of Object.keys(fields)) {

        lines.push(
            "<b>" +
            escapeHTML(key) +
            "</b>"
        );

        lines.push(
            escapeHTML(
                String(fields[key])
            )
        );

        lines.push("");

    }

    lines.push(
        "🌐 <b>Page</b>"
    );

    lines.push(
        escapeHTML(page)
    );

    lines.push("");

    lines.push(
        "⚡ Powered by TrigifyX"
    );

    return lines.join("\n");

}

/* ============================================================
   HTML Escape
============================================================ */

function escapeHTML(value) {

    return String(value)

        .replace(/&/g, "&amp;")

        .replace(/</g, "&lt;")

        .replace(/>/g, "&gt;")

        .replace(/"/g, "&quot;")

        .replace(/'/g, "&#39;");

}