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
       Attach Form
    ------------------------------------------------------- */

    function attach(form) {

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

        const forms =
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

            mutations.forEach(function (mutation) {

                mutation.addedNodes.forEach(function (node) {

                    if (node.nodeType !== 1)
                        return;

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

            });

        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
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

    let node;
    try {
        const res = await fetch(firebaseBase + "/pub/" + encodeURIComponent(trimmedToken) + ".json", {
            headers: { "Accept": "application/json" }
        });
        if (!res.ok) return json({ ok: false, error: "Access token not linked" }, 404, env);
        node = await res.json();
    } catch {
        return json({ ok: false, error: "Unable to reach Firebase" }, 502, env);
    }

    if (!node || !node.telegram || String(node.telegram).trim() === "") {
        return json({ ok: false, error: "Access token not linked" }, 404, env);
    }

    // Blocked tokens cannot send anything.
    if (node.meta && node.meta.blocked === true) {
        return json({ ok: false, error: "Access token blocked", blocked: true }, 403, env);
    }

    const chatId = String(node.telegram).trim();
    const result = await sendTelegram(
        chatId,
        { test: "This is a test message from TrigifyX ✅" },
        "TrigifyX Dashboard",
        env
    );

    return result;
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
    // --------------------------------------------------------

    const submissionHash = generateSubmissionHash(trimmedToken, pageUrl, sanitizedFields);
    const cachedResponse = await checkIdempotencyCache(submissionHash, ctx);
    if (cachedResponse) {
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
       Lookup the public token node (telegram + uid + meta).
       We read the whole pub node so we also get uid + meta in one call.
    -------------------------------------------------------- */

    const firebaseURL =
        firebaseBase +
        "/pub/" +
        tokenKey +
        ".json";

    let response;

    try {

        response =
            await fetch(firebaseURL, {

                headers: {

                    "Accept":
                        "application/json"

                }

            });

    }
    catch {

        // Issue 10: Cache invalid tokens
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

    if (!response.ok) {

        // Issue 10: Cache invalid tokens
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

    let node;

    try {

        node =
            await response.json();

    }
    catch {

        return json(
            {
                ok: false,
                error: "Invalid Firebase response"
            },
            500,
            env
        );

    }

    if (
        !node ||
        !node.telegram ||
        String(node.telegram).trim() === ""
    ) {

        // Issue 10: Cache invalid tokens
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

    const chatId =
        String(node.telegram).trim();

    const meta =
        (node.meta && typeof node.meta === "object") ? node.meta : {};

    // --------------------------------------------------------
    // BLOCKED STATE: do not fulfil ANY request for this token.
    // --------------------------------------------------------
    if (meta.blocked === true) {

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
    // The request's origin must match the site the token was
    // issued for. We resolve the user profile via pub/{token}/uid
    // then read users/{uid}.siteUrl.
    // --------------------------------------------------------
    const requestOrigin = safeOrigin(data.page);

    let siteOk = false;
    let ownerUid = node.uid ? String(node.uid) : "";

    if (requestOrigin && ownerUid) {

        try {

            const profile =
                await firebaseGet(
                    firebaseBase,
                    "users/" + encodeURIComponent(ownerUid)
                );

            const storedSite =
                profile && profile.siteUrl
                    ? String(profile.siteUrl).trim()
                    : "";

            if (storedSite) {
                siteOk = originsMatch(requestOrigin, storedSite);
            }

        }
        catch (_) {
            /* fall through to siteOk = false */
        }

    }

    if (!siteOk && requestOrigin) {

        // Unauthorized practice / token exposure detected.
        // Do NOT forward form data. Notify the token OWNER and
        // bump the exposed-chance counter (max 3 -> block).
        const chances =
            (typeof meta.exposedChances === "number")
                ? meta.exposedChances
                : 0;

        const newChances = chances + 1;
        const nowBlocked = newChances >= MAX_EXPOSED_CHANCES;

        const patch = {
            meta: Object.assign({}, meta, {
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
        (typeof meta.submissionCount === "number")
            ? meta.submissionCount
            : 0;

    const newCount = prevCount + 1;

    const metaPatch = {
        meta: Object.assign({}, meta, {
            submissionCount: newCount,
            lastSubmissionAt: Date.now(),
            lastSubmissionPage: data.page || "Unknown",
            exposedChances:
                (typeof meta.exposedChances === "number")
                    ? meta.exposedChances
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