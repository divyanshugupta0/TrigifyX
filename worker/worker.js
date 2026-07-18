/*
 * ============================================================
 * TrigifyX Cloudflare Worker
 * Version 3.0
 * ============================================================
 *
 * Routes
 *   GET  /
 *   GET  /health
 *   GET  /trigifyx-capture.js
 *   POST /api/submit
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
       Runtime State
    ------------------------------------------------------- */

    const inFlight = new Set();
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
       Queue Helpers
    ------------------------------------------------------- */

    function getQueue() {
        return read(STORAGE.QUEUE, []);
    }

    function saveQueue(queue) {
        write(STORAGE.QUEUE, queue);
    }

    function enqueue(item) {
        const queue = getQueue();

        const exists = queue.some(q => q.id === item.id);

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
       Send One Queue Item
    ------------------------------------------------------- */

    async function sendOne(item, attempt = 0) {

        if (inFlight.has(item.id))
            return;

        if (alreadyDelivered(item.signature)) {

            dequeue(item.id);
            return;

        }

        inFlight.add(item.id);

        try {

            const result = await deliver(item);

            if (!result.ok)
                throw new Error("Worker rejected request");

            dequeue(item.id);

            markDelivered(item.signature);

            recent.delete(item.signature);

            console.log(
                "[TrigifyX] Delivered successfully."
            );

        }
        catch (err) {

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
        finally {

            inFlight.delete(item.id);

        }

    }

    /* -------------------------------------------------------
       Flush Offline Queue
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

            sendOne(item);

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

        sendOne(item);

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
   CORS
============================================================ */

function cors(response, env) {

    const allowed =
        getEnv(env, "ALLOWED_ORIGINS") || "*";

    response.headers.set(
        "Access-Control-Allow-Origin",
        allowed
    );

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

    return response;

}

/* ============================================================
   Handle Form Submission
============================================================ */

async function handleSubmit(request, env, ctx) {

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
        Object.keys(fields).length > 100
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
                .slice(0, 100);

        const safeValue =
            String(fields[key] ?? "")
                .trim()
                .slice(0, 5000);

        sanitizedFields[safeKey] = safeValue;

    }

    // --------------------------------------------------------
    // Continue Processing
    // --------------------------------------------------------

    return await resolveDestination(

        {
            accessToken: accessToken.trim(),
            fields: sanitizedFields,
            page: pageUrl
        },

        env,
        ctx

    );

}

/* ============================================================
   Resolve Destination (Firebase)
============================================================ */

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

    const cacheKey =
        "https://cache.trigifyx/" +
        encodeURIComponent(data.accessToken);

    const cache =
        caches.default;

    /* --------------------------------------------------------
       Check Cloudflare Cache
    -------------------------------------------------------- */

    let cached =
        await cache.match(cacheKey);

    if (cached) {

        const cachedJson =
            await cached.json();

        return await sendTelegram(

            cachedJson.chatId,

            data.fields,

            data.page,

            env

        );

    }

    /* --------------------------------------------------------
       Lookup Firebase
    -------------------------------------------------------- */

    const firebaseURL =
        firebaseBase +
        "/pub/" +
        encodeURIComponent(
            data.accessToken
        ) +
        "/telegram.json";

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

        return json(
            {
                ok: false,
                error: "Firebase lookup failed"
            },
            404,
            env
        );

    }

    let value;

    try {

        value =
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
        !value ||
        String(value).trim() === ""
    ) {

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
        String(value).trim();

    /* --------------------------------------------------------
       Cache chatId
    -------------------------------------------------------- */

    ctx.waitUntil(

        cache.put(

            cacheKey,

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
       Continue
    -------------------------------------------------------- */

    return await sendTelegram(

        chatId,

        data.fields,

        data.page,

        env

    );

}

/* ============================================================
   Send Telegram Message
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

                })

            }
        );

    }
    catch (err) {

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